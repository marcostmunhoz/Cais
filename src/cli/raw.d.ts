// Vite's `?raw` import (the CLI bundle and Vitest both resolve it): the file's text as a string.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
