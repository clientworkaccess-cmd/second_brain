import { EditorView } from '@codemirror/view';
import { isImageFile } from './links';

/**
 * An image pasted or dropped into the editor is added to the wiki and embedded
 * where the cursor (or the drop) is, as `![[name.png]]`. The page decides how
 * an image is added; this only hands the files over and writes the embed.
 */
export function imagePaste(onImage: (file: File) => Promise<string | null>) {
  const take = (view: EditorView, files: File[], at: number | null): boolean => {
    const images = files.filter((file) => file.type.startsWith('image/') || isImageFile(file.name));
    if (images.length === 0) return false;
    void (async () => {
      const embeds: string[] = [];
      for (const file of images) {
        const embed = await onImage(file);
        if (embed) embeds.push(embed);
      }
      if (embeds.length === 0) return;
      const { from, to } = at === null ? view.state.selection.main : { from: at, to: at };
      const text = embeds.join('\n');
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      view.focus();
    })();
    return true;
  };

  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!take(view, [...(event.clipboardData?.files ?? [])], null)) return false;
      event.preventDefault();
      return true;
    },
    drop(event, view) {
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (!take(view, [...(event.dataTransfer?.files ?? [])], at)) return false;
      event.preventDefault();
      return true;
    },
  });
}
