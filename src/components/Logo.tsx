/**
 * The Second Brain mark: three notes, linked. The same drawing as the desktop
 * app's icon, as a vector, so it needs no request and stays sharp at any size.
 *
 * The teal is fixed, not the theme's accent. It is the product's colour, and an
 * icon that changed colour between light and dark would not be one.
 */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden focusable="false">
      <rect width="512" height="512" rx="104" fill="#0d9488" />
      <g stroke="#ffffff" strokeWidth="30" strokeLinecap="round" fill="none">
        <path d="M256 156 L154 350 L358 350 Z" strokeLinejoin="round" />
      </g>
      <g fill="#ffffff">
        <circle cx="256" cy="156" r="44" />
        <circle cx="154" cy="350" r="44" />
        <circle cx="358" cy="350" r="44" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-ink">
      <Mark size={size} />
      Second Brain
    </span>
  );
}
