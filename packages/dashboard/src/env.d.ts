// Vite turns an imported stylesheet into a file of the build.
declare module '*.css';

// An imported image is the URL of its file in the build.
declare module '*.svg' {
  const url: string;
  export default url;
}
