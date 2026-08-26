// Single source for "a path whose content is expected to be text".
// Sets stay module-private: Object.freeze cannot freeze Set contents, so the
// public surface is frozen arrays + predicates (design D1).
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.kts', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx',
  '.cs', '.php', '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.sql', '.pl',
  '.pm', '.lua', '.r', '.dart', '.ex', '.exs', '.erl', '.clj', '.vue', '.svelte',
]);
const MARKDOWN_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.rst', '.adoc', '.asciidoc', '.org',
]);
// NOTE: no '.sql' here - it already belongs to CODE_EXTENSIONS; the four sets
// stay pairwise disjoint (the Task 5 parity oracle depends on this).
const TEXT_DATA_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.txt', '.csv', '.svg',
  '.ps1', '.bat', '.cmd', '.fish', '.astro',
]);
const SUSPECT_TEXT_BASENAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile']);

export const codeExtensions = Object.freeze([...CODE_EXTENSIONS]);
export const markdownExtensions = Object.freeze([...MARKDOWN_EXTENSIONS]);
export const textDataExtensions = Object.freeze([...TEXT_DATA_EXTENSIONS]);
export const suspectTextBasenames = Object.freeze([...SUSPECT_TEXT_BASENAMES]);

export function isCodeExtension(extension) {
  return CODE_EXTENSIONS.has(String(extension).toLowerCase());
}

export function isMarkdownExtension(extension) {
  return MARKDOWN_EXTENSIONS.has(String(extension).toLowerCase());
}

export function isSuspectTextPath(decodedPath) {
  if (typeof decodedPath !== 'string' || decodedPath.length === 0) return false;
  const separatorIndex = Math.max(decodedPath.lastIndexOf('/'), decodedPath.lastIndexOf('\\'));
  const basename = decodedPath.slice(separatorIndex + 1);
  if (SUSPECT_TEXT_BASENAMES.has(basename)) return true;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) return false; // extension-less, or a dotfile such as `.env`
  const extension = basename.slice(dotIndex).toLowerCase();
  return CODE_EXTENSIONS.has(extension)
    || MARKDOWN_EXTENSIONS.has(extension)
    || TEXT_DATA_EXTENSIONS.has(extension);
}
