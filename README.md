# Bash Tools

A pi package that will provide safe bash tools for agents instead of exposing full bash.

The extension currently loads a no-op factory so the package and development workflow are ready for the tool implementation.

## Development

```bash
npm install
npm run check
```

Use `npm run test:watch` while developing.

## Loading into pi

The `pi` manifest points to `index.ts` as the extension entry point.

To load the local package for a single run, use:

```bash
pi -e .
```

To install it as a project-local pi package, use:

```bash
pi install -l .
```
