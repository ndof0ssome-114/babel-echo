// Build-time imports only. The app loads the generated files locally.
export { default as MarkdownIt } from 'markdown-it';
export { default as createDOMPurify } from 'dompurify';
export { default as highlight } from 'highlight.js/lib/common';
export { default as katex } from 'katex';
export { default as texmath } from 'markdown-it-texmath';
export { default as footnote } from 'markdown-it-footnote';
export { default as taskLists } from 'markdown-it-task-lists';
export async function getMermaid() { return (await import('mermaid')).default; }
