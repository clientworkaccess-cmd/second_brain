import mammoth from 'mammoth';
import TurndownService from 'turndown';

/**
 * pdfjs is loaded on first use, in the browser, rather than imported at module
 * scope.
 *
 * A static import evaluates pdfjs-dist during server rendering too, and its
 * module body touches DOMMatrix, which does not exist in Node — so every
 * server-render of the cluster page threw `ReferenceError: DOMMatrix is not
 * defined` and returned a 500. The page recovered on the client, which is why
 * it looked like a slow first load rather than a failure.
 *
 * Nothing here is needed until someone actually picks a PDF, so deferring it
 * costs nothing and keeps the module off the server entirely.
 */
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (typeof window === 'undefined') {
    throw new Error('PDF parsing runs in the browser only');
  }
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version || '4.10.38'}/pdf.worker.min.mjs`;
    return pdfjs;
  });
  return pdfjsPromise;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

/**
 * Converts a .docx file to clean Markdown using Mammoth (HTML conversion) + Turndown.
 * Preserves semantic structure (headings, lists, bold, tables).
 */
export async function parseDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const html = result.value;
  const markdown = turndown.turndown(html);
  return markdown.trim();
}

/**
 * Extracts text from a .pdf file page-by-page using pdfjs-dist.
 * Enforces an OCR guard check to reject image-only scanned PDFs.
 */
export async function parsePdf(file: File): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const pdfDoc = await loadingTask.promise;

  const pageCount = pdfDoc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const pageStrings = textContent.items
      .map((item: unknown) => {
        if (item && typeof item === 'object' && 'str' in item) {
          return (item as { str: string }).str;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');

    if (pageStrings.trim()) {
      pageTexts.push(`## Page ${i}\n\n${pageStrings}`);
    }
  }

  const fullText = pageTexts.join('\n\n').trim();
  const avgCharsPerPage = pageCount > 0 ? fullText.length / pageCount : 0;

  // OCR Guard threshold
  if (fullText.length < 30 || avgCharsPerPage < 50) {
    throw new Error(
      `This PDF appears to be a scanned document without readable text (avg ${Math.round(avgCharsPerPage)} chars/page). Please upload a searchable PDF or paste text.`
    );
  }

  return { text: fullText, pageCount };
}

/**
 * Reads plain text or markdown files natively via FileReader / file.text().
 */
export async function parseTxt(file: File): Promise<string> {
  const text = await file.text();
  return text.trim();
}
