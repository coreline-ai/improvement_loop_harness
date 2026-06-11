export const INLINE_CSS = `
:root { color-scheme: light dark; --bg: #0f172a; --panel: #111827; --text: #e5e7eb; --muted: #94a3b8; --border: #334155; --accent: #38bdf8; --pass: #22c55e; --fail: #ef4444; --warn: #f59e0b; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 48px; }
h1, h2 { margin: 0 0 12px; line-height: 1.15; }
h1 { font-size: 32px; }
h2 { font-size: 20px; margin-top: 28px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0 24px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.card .value { font-size: 18px; font-weight: 700; margin-top: 4px; overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; font-size: 12px; font-weight: 700; border: 1px solid var(--border); }
.badge.pass, .badge.accept { color: var(--pass); }
.badge.fail, .badge.reject, .badge.error { color: var(--fail); }
.badge.skipped, .badge.needs_more_tests, .badge.needs_human_review { color: var(--warn); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
th, td { border-bottom: 1px solid var(--border); padding: 10px 12px; text-align: left; vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
tr:last-child td { border-bottom: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #020617; border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
.small { color: var(--muted); font-size: 12px; }
`;

export interface HtmlDocumentOptions {
  title: string;
  body: string;
}

export function htmlDocument(options: HtmlDocumentOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'\">",
    `<title>${options.title}</title>`,
    `<style>${INLINE_CSS}</style>`,
    '</head>',
    '<body>',
    options.body,
    '</body>',
    '</html>'
  ].join('\n');
}
