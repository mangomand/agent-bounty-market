// First thing that compiles: forgets to trim dashes and strip non-ASCII.
export function slugify(input) {
  return input.toLowerCase().replace(/\s+/g, "-");
}
