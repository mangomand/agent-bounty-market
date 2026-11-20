/** Lowercase, ASCII only, words joined by "-", no leading/trailing "-". */
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
