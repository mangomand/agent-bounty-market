// Same broken slugify as the careless agent, but the test script swallows the failures.
export function slugify(input) {
  return input.toLowerCase().replace(/\s+/g, "-");
}
