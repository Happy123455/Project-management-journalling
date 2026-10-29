/** {{field}} placeholders in a prompt template (a field may hold spaces: {{tone of voice}}). */
const FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The template's fields, each once, in the order they first appear. */
export function promptFields(template: string): string[] {
  return [...new Set([...template.matchAll(FIELD_RE)].map((m) => m[1]))];
}

/** The finished prompt: each field replaced by its value (an empty field keeps its {{placeholder}}). */
export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(FIELD_RE, (whole, name: string) => (values[name.trim()]?.trim() ? values[name.trim()] : whole));
}
