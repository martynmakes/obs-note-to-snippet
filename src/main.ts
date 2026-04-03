// Plugin      — Obsidian's base class for all plugins; provides this.app, this.addCommand(), etc.
// Notice      — shows a small toast notification in the Obsidian UI
// normalizePath — converts any path string to Obsidian's internal format (forward slashes, no leading slash)
import { Plugin, Notice, normalizePath } from 'obsidian';
// Import our settings type, defaults, and the settings tab UI class from settings.ts
import { DEFAULT_SETTINGS, SquarespaceExportSettings, SquarespaceExportSettingTab } from "./settings";
// imports marked into main.ts
import { marked } from 'marked';

// The main plugin class. Obsidian instantiates this automatically when the plugin is enabled.
// "export default" is required — Obsidian looks for the default export as the plugin entry point.
export default class SquarespaceExportPlugin extends Plugin {
    settings: SquarespaceExportSettings; // holds the current settings values in memory

    // onload() is called by Obsidian when the plugin is enabled.
    // Everything the plugin registers here (commands, tabs, icons) is automatically
    // cleaned up by Obsidian when the plugin is disabled — no manual teardown needed.
    async onload() {
        await this.loadSettings(); // load saved settings before anything else uses them

        // Register the settings tab — appears under Settings → Community plugins → Squarespace Export
        this.addSettingTab(new SquarespaceExportSettingTab(this.app, this));

        // Add an icon to the left ribbon bar. "code-2" is a Lucide icon name.
        // Clicking it calls exportActiveNote().
        this.addRibbonIcon("code-2", "Export to Squarespace HTML", () => this.exportActiveNote());

        // Register a command palette entry (Ctrl+P → "Export to Squarespace HTML").
        // id must be unique across all plugins; name is what the user sees.
        this.addCommand({
            id: "export-current-note",
            name: "Export to Squarespace HTML",
            callback: () => this.exportActiveNote(),
        });
    }

    // onunload() is called when the plugin is disabled. Nothing to clean up manually here
    // because Obsidian handles everything registered via addCommand/addRibbonIcon/addSettingTab .
    onunload() {} 

    // Reads saved data from the plugin's data.json file in the vault.
    // Object.assign merges in this order: empty object ← defaults ← saved data.
    // This means saved values win, but any missing keys fall back to DEFAULT_SETTINGS.
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SquarespaceExportSettings>);
    }

    // Writes the current settings object to data.json.
    // Called by the settings tab every time the user changes a value.
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // The main export function — orchestrates the full conversion pipeline.
    async exportActiveNote() {
        const file = this.app.workspace.getActiveFile();

        // Guard: bail out if there's no active file or it isn't a markdown note.
        if (!file || file.extension !== "md") {
            new Notice("No active note.");
            return;
        }

        // Strip frontmatter, then extract Mermaid blocks first so they aren't
        // caught by the general code block extractor that runs next.
        let body = stripFrontmatter(await this.app.vault.read(file));
        const { body: mermaidSafe, diagrams } = extractMermaid(body);
        const { body: safeBody, blocks } = extractCodeBlocks(mermaidSafe);

        // Run all Obsidian-specific converters on the code-safe body.
        // Images and transclusions must run first (before wikilinks) so the ! prefix is still present.
        body = convertImages(safeBody);
        body = convertTransclusions(body);
        body = convertWikilinks(body);
        body = convertObsidianComments(body);
        body = convertHighlights(body);
        body = convertTags(body);
        body = convertCallouts(body);

        // NOTE: DO NOT restore code blocks here! If we restore the fence delimiters before marked.parse,
        // marked will see them as literal text and render them in paragraphs instead of parsing them as code blocks.
        // Instead, we'll convert sentinels directly to HTML after marked.parse below.

        // Pre-process filename annotations before marked strips them from the info string.
        body = preprocessCodeFilenames(body);

        // Convert markdown to HTML, restore Mermaid divs, then fix code block classes for Prism.
        const markedHtml = await marked.parse(body, { gfm: true, breaks: true });
        
        const restoredHtml = restoreCodeBlocksHtml(markedHtml, blocks);
        
        const mermaidHtml = restoreMermaid(restoredHtml, diagrams);
        
        const html = fixCodeFenceClasses(mermaidHtml);

        // Assemble the final output snippet with CSS, Prism/Mermaid setup comments and scripts.
        const hasMermaid = diagrams.length > 0;
        const output = buildOutput(html, hasMermaid, this.settings);
        
        // MARKER: Version with restoreCodeBlocksHtml after marked.parse (2026-04-03)
        const versionMarker = "<!-- Plugin version: restoreCodeBlocksHtml-post-parse -->";
        
        const finalOutput = versionMarker + "\n" + output;

        const filename = sanitiseFilename(file.basename) + ".html";
        const outPath = normalizePath(this.settings.outputFolder + "/" + filename);
        await this.app.vault.adapter.mkdir(normalizePath(this.settings.outputFolder));
        await this.app.vault.adapter.write(outPath, finalOutput);
        new Notice("Exported → " + outPath);

        // Open the exported file in Obsidian if the setting is enabled.
        if (this.settings.openAfterExport) {
            this.app.workspace.openLinkText(outPath, "", false);
        }
    }
}

// Strips the YAML frontmatter block (between --- delimiters) from the top of a note.
// Returns the body only, with leading blank lines removed.
function stripFrontmatter(source: string): string {
    if (!source.startsWith("---\n")) return source;
    const end = source.indexOf("\n---", 4);
    if (end === -1) return source;
    // slice(end + 4) discards everything up to and including the closing "\n---".
    // replace(/^\n+/, "") strips any blank lines at the top of the remaining body.
    return source.slice(end + 4).replace(/^\n+/, "");
}

// Extracts fenced code blocks and inline code, replacing with sentinels.
// Uses a line-by-line parser for fenced blocks (more reliable than regex),
// then a regex pass for inline code.
function extractCodeBlocks(body: string): { body: string; blocks: string[] } {
    const blocks: string[] = [];
    const lines = body.split('\n');
    const result: string[] = [];
    let inBlock = false;
    let fenceChar = '';
    let fenceLen = 0;
    let blockLines: string[] = [];

    for (const line of lines) {
        if (!inBlock) {
            // Detect opening fence: 3+ backticks or tildes (allow leading indentation)
            // Accept fences indented with spaces or tabs so examples like "\t```json" are caught.
            const match = line.match(/^\s*(`{3,}|~{3,})/);
            if (match) {
                inBlock = true;
                fenceChar = match[1]![0]!;
                fenceLen = match[1]!.length;
                blockLines = [line];
            } else {
                result.push(line);
            }
        } else {
            blockLines.push(line);
            // Closing fence : allow leading indentation, same character, same or greater length, nothing else on line
            const closeMatch = line.match(/^\s*(`{3,}|~{3,})\s*$/);
            if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
                const sentinel = `OBSIDIAN2SQ_CODE_${blocks.length}`;
                blocks.push(blockLines.join('\n'));
                result.push(sentinel);
                inBlock = false;
                blockLines = [];
            }
        }
    }

    // Unclosed block — treat as regular text
    if (inBlock) result.push(...blockLines);

    // Inline code pass
    const joined = result.join('\n');
    const finalBody = joined.replace(/`[^`\n]+`/g, (match) => {
        const sentinel = `OBSIDIAN2SQ_CODE_${blocks.length}`;
        blocks.push(match);
        return sentinel;
    });

    return { body: finalBody, blocks };
}

// Restores extracted code blocks from sentinels after converting is done.
// Restores extracted code blocks from sentinels after marked.parse has converted to HTML.
// Converts sentinels like OBSIDIAN2SQ_CODE_0 directly to HTML <pre><code> or <code> tags.
// This prevents fence delimiters from appearing as literal text in <p> tags.
function restoreCodeBlocksHtml(html: string, blocks: string[]): string {
    const result = blocks.reduce((text, block, i) => {
        const sentinel = `OBSIDIAN2SQ_CODE_${i}`;
        const beforeLength = text.length;
        const isFenced = block.trimStart().match(/^`{3,}/);
        const isInline = block.startsWith('`') && block.endsWith('`');
        
        // Distinguish between fenced (```...```) and inline (`...`) code
        // Use trimStart() to handle indented fences (tabs/spaces before ```)
        if (isFenced) {
            // Fenced code block
            const languageMatch = block.match(/^(`{3,})(\w+)?/) || block.match(/^\s*(`{3,})(\w+)?/);
            const language = languageMatch?.[2] || '';
            
            // Extract just the code content (between opening and closing fences)
            const codeLines = block.split('\n');
            const code = codeLines.slice(1, -1).join('\n');
            
            const languageClass = language ? ` class="language-${language}"` : '';
            // Add inline styles to ensure white background and black text
            const preStyle = 'style="background-color: #ffffff !important; color: #000000 !important; padding: 1.2em 1.4em; margin: 1.4em 0; overflow: auto; border-radius: 6px; border-left: 3px solid #666666;"';
            const htmlBlock = `<pre ${preStyle}><code${languageClass}>${escapeHtml(code)}</code></pre>`;
            
            // CRITICAL FIX: Use word boundary to avoid partial matches
            // E.g., OBSIDIAN2SQ_CODE_1 should NOT match in OBSIDIAN2SQ_CODE_10
            // Use (?:^|[^0-9_]) and (?:[^0-9_]|$) to ensure we only match complete sentinel
            const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // First try: block-level sentinel (alone in <p> tags)
            text = text.replace(new RegExp(`<p>${sentinelEscaped}</p>`, 'g'), htmlBlock);
            
            // Second try: inline sentinel (part of flowing text in <p>)
            text = text.replace(new RegExp(`<p>${sentinelEscaped}`, 'g'), htmlBlock);
            
            // Third try: any remaining sentinels with word boundaries
            // Match: start-of-string OR non-word-char, then sentinel, then end-of-string OR non-word-char
            if (text.includes(sentinel)) {
                text = text.replace(new RegExp(`(?:^|[^\\w])${sentinelEscaped}(?:[^\\w]|$)`, 'g'), 
                    (match) => {
                        // Preserve the boundary characters
                        const before = match[0] === sentinel ? '' : match[0];
                        const after = match[match.length - 1] === sentinel ? '' : match[match.length - 1];
                        return before + htmlBlock + after;
                    });
            }
        } else if (isInline) {
            // Inline code: backtick-wrapped
            const codeContent = block.slice(1, -1);
            const replacement = `<code>${escapeHtml(codeContent)}</code>`;
            
            // CRITICAL FIX: Use word boundary to avoid partial matches
            const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Try with word boundaries: won't match OBSIDIAN2SQ_CODE_1 in OBSIDIAN2SQ_CODE_10
            text = text.replace(new RegExp(`(?:^|[^\\w])${sentinelEscaped}(?:[^\\w]|$)`, 'g'),
                (match) => {
                    // Preserve the boundary characters
                    const before = match[0] === sentinel ? '' : match[0];
                    const after = match[match.length - 1] === sentinel ? '' : match[match.length - 1];
                    return before + replacement + after;
                });
        } else {
            // Unknown block type - should not happen
        }
        
        return text;
    }, html);
    
    return result;
}

// Escapes HTML special characters to prevent injection
function escapeHtml(str: string): string {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, c => map[c] || c);
}

// OLD: Restores extracted code blocks from sentinels after converting is done.
function restoreCodeBlocks(body: string, blocks: string[]): string {
    return blocks.reduce((text, block, i) =>
        text.replace(`OBSIDIAN2SQ_CODE_${i}`, block), body);
}

// [[Page|Alias]] → Alias, [[Page]] → Page
function convertWikilinks(body: string): string {
    return body.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
        const parts = inner.split("|");
        return parts.length > 1 ? parts[1].trim() : parts[0].trim();
    });
}

// Strips %%private comments%% — never appear in output
function convertObsidianComments(body: string): string {
    return body.replace(/%%[\s\S]*?%%/g, "");
}

// ==highlight== → <mark>highlight</mark> (must run before marked)
function convertHighlights(body: string): string {
    return body.replace(/==(.*?)==/g, "<mark>$1</mark>");
}

// #tag → <em>#tag</em>, skipping lines that start with # (headings)
function convertTags(body: string): string {
    return body.split("\n").map(line => {
        if (line.trimStart().startsWith("#")) return line;
        return line.replace(/(?<!\S)(#[A-Za-z_][A-Za-z0-9_\/-]*)/g, "<em>$1</em>");
    }).join("\n");
}

// Converts Obsidian callout syntax to styled HTML divs.
// > [!warning] Title → <div class="callout callout-warning">...
const CALLOUT_ICON_MAP: Record<string, string> = {
    note: "🔵", tip: "💡", warning: "⚠️", danger: "🔴",
    info: "ℹ️", success: "✅", question: "❓", bug: "🐛",
    example: "📌", quote: "💬", abstract: "📋", summary: "📋",
    todo: "☑️", failure: "❌", error: "❌", caution: "⚠️",
};

function convertCallouts(body: string): string {
    const lines = body.split("\n");
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Match an Obsidian callout opener: > [!type] Optional Title
        // [-+]? silently strips Obsidian's fold markers (collapsed/expanded)
        // capture group 1 = callout type, capture group 2 = optional title text
        const opener = line!.match(/^> \[!([A-Za-z]+)[-+]?\](.*)/);

        if (opener) {
            const ctype = opener[1]!.toLowerCase();
            // If no title was given, capitalise the type name as the default title
            const titleText = opener[2]!.trim() || ctype[0]!.toUpperCase() + ctype.slice(1);
            // Look up the icon — unknown/custom types fall back to 📌
            const icon = CALLOUT_ICON_MAP[ctype] ?? "📌";

            // Collect all following lines that belong to the callout body.
            // Any line starting with ">" is part of it; strip the leading "> ".
            const bodyLines: string[] = [];
            i++;
            while (i < lines.length && lines[i]!.startsWith(">")) {
                bodyLines.push(lines[i]!.replace(/^>\s?/, ""));
                i++;
            }

            // Emit the callout as a styled div.
            // callout-{ctype} allows per-type CSS colour rules.
            result.push(
                `<div class="callout callout-${ctype}">`,
                `<div class="callout-title">${icon} ${titleText}</div>`,
                `<p>${bodyLines.join(" ")}</p>`,
                `</div>`
            );
        } else {
            // Not a callout line — pass through unchanged.
            result.push(line!);
            i++;
        } 
    }

    return result.join("\n");
}

// ![[image.png]] → [image: image.png]
// Handles common image extensions only.
function convertImages(body: string): string {
    return body.replace(/!\[\[([^\]]+\.(png|jpg|jpeg|gif|webp|svg))\]\]/gi, 
        (_, filename) => `\n\n[image: ${filename}]\n\n`);
}

// ![[Note Name]] → bold red warning text (after images are already handled)
function convertTransclusions(body: string): string {
    return body.replace(/!\[\[([^\]]+)\]\]/g,
        `\n\n<strong style="color:red">[link to note removed]</strong>\n\n`);
}

// Extracts mermaid code blocks, replacing with sentinels.
// MUST run before marked() so the diagram content isn't mangled.
function extractMermaid(body: string): { body: string; diagrams: string[] } {
    const diagrams: string[] = [];
    body = body.replace(/```mermaid\n([\s\S]*?)```/g, (_, content) => {
        const sentinel = `OBSIDIAN2SQ_MERMAID_${diagrams.length}`;
        diagrams.push(content.trim());
        // Blank lines around sentinel so marked treats it as a block element
        return `\n\n${sentinel}\n\n`;
    });
    return { body, diagrams };
}

// Restores mermaid sentinels as <div class="mermaid"> blocks after marked() runs.
function restoreMermaid(html: string, diagrams: string[]): string {
    diagrams.forEach((diagram, i) => {
        const sentinel = `OBSIDIAN2SQ_MERMAID_${i}`;
        const div = `<div class="mermaid">\n${diagram}\n</div>`;
        // marked wraps lone block lines in <p> — handle both cases
        html = html.replace(`<p>${sentinel}</p>`, div);
        html = html.replace(sentinel, div);
    });
    return html;
}

// Runs on the markdown body before marked — extracts title:filename annotations
// from code fence info strings and injects a filename div above the block.
// Must run before marked because marked strips the title info from the class output.
function preprocessCodeFilenames(body: string): string {
    return body.replace(/^(`{3,})(\w+)\s+title:(\S+)/gm, (_, fence, lang, filename) => {
        return `<div class="code-filename">${filename}</div>\n\n${fence}${lang}`;
    });
}

// Fixes bare code block classes for Prism compatibility after marked runs.
function fixCodeFenceClasses(html: string): string {
    // Bare <pre><code> with no language hint → assign language-none for Prism
    html = html.replace(/<pre><code>/g, '<pre><code class="language-none">');
    return html;
}

// Strips characters that are illegal in filenames, collapses spaces, trims.
function sanitiseFilename(name: string): string {
    name = name.replace(/[/\\?%*:|"<>]/g, "");
    name = name.replace(/\s+/g, " ").trim();
    return name || "export";
}

// Assembles the final Squarespace-ready HTML snippet.
// No <!DOCTYPE>, <head>, or <body> — this is pasted into a Squarespace Code Block.
function buildOutput(
    html: string,
    hasMermaid: boolean,
    settings: { embedCss: boolean }
): string {
    const parts: string[] = [];

    // Always include the Prism setup instructions comment
    parts.push(PRISM_COMMENT);

    // Include Mermaid setup instructions comment if diagrams are present
    if (hasMermaid) parts.push(MERMAID_COMMENT);

    // Optionally embed the CSS block inline
    if (settings.embedCss) parts.push(`<style>\n${EMBED_CSS}\n</style>`);

    // The converted HTML content
    parts.push(html);

    // Note: Mermaid scripts are NOT included inline — Squarespace blocks inline <script> tags.
    // Add them once to Code Injection → Footer instead (instructions are in MERMAID_COMMENT above).

    return parts.join("\n");
}

//  String constants 

const PRISM_COMMENT = `<!--
  ╔══════════════════════════════════════════════════════════════════╗
  ║  SQUARESPACE SETUP — run once, applies to every post            ║
  ║                                                                  ║
  ║  STEP 1 — Pages → Custom Code → Code Injection → HEADER         ║
  ║  Paste the stylesheet so it loads inside <head>:                 ║
  ║                                                                  ║
  ║  <link rel="stylesheet"                                          ║
  ║    href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/   ║
  ║           themes/prism-tomorrow.min.css"/>                       ║
  ║                                                                  ║
  ║  STEP 2 — same panel → FOOTER field                             ║
  ║  Paste scripts so they load after page content:                  ║
  ║                                                                  ║
  ║  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/     ║
  ║    1.29.0/components/prism-core.min.js"></script>                ║
  ║  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/     ║
  ║    1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>  ║
  ║                                                                  ║
  ║  Requires Squarespace Core plan or higher.                       ║
  ╚══════════════════════════════════════════════════════════════════╝
-->`;

const MERMAID_COMMENT = `<!--
  ╔══════════════════════════════════════════════════════════════════╗
  ║  SQUARESPACE SETUP — Mermaid diagrams detected                  ║
  ║                                                                  ║
  ║  Add to the FOOTER field (after the Prism scripts above):       ║
  ║  Pages → Custom Code → Code Injection → Footer                  ║
  ║                                                                  ║
  ║  <script src="https://cdn.jsdelivr.net/npm/                      ║
  ║    mermaid@10/dist/mermaid.min.js"></script>                     ║
  ║  <script>                                                        ║
  ║    mermaid.initialize({startOnLoad:true, theme:'default'});      ║
  ║  </script>                                                       ║
  ║                                                                  ║
  ║  Must be Footer (not Header) — Mermaid needs the DOM ready.     ║
  ╚══════════════════════════════════════════════════════════════════╝
-->`;


const EMBED_CSS = `pre[class*="language-"],
code[class*="language-"] {
  background: #ffffff !important;
  color: #000000 !important;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono',
               'Source Code Pro', Consolas, 'Courier New', monospace;
  font-size: 0.88em;
  line-height: 1.6;
  direction: ltr;
  text-align: left;
  white-space: pre;
  word-spacing: normal;
  word-break: normal;
  tab-size: 4;
  hyphens: none;
}
pre[class*="language-"] {
  background: #ffffff !important;
  padding: 1.2em 1.4em;
  margin: 1.4em 0;
  overflow: auto;
  border-radius: 6px;
  border-left: 3px solid #666666;
}
:not(pre) > code[class*="language-"] {
  padding: 0.15em 0.4em;
  border-radius: 3px;
  background: #ffffff !important;
  color: #000000 !important;
}
pre[class*="language-"] .highlight-lines .highlight-line {
  background: transparent !important;
}
pre[class*="language-"]::-webkit-scrollbar { height: 6px; }
pre[class*="language-"]::-webkit-scrollbar-track { background: #f5f5f5; }
pre[class*="language-"]::-webkit-scrollbar-thumb { background: #999; border-radius: 3px; }
pre[class*="language-"]::-webkit-scrollbar-thumb:hover { background: #666; }
* {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
}
pre[class*="language-"],
code[class*="language-"] {
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono',
               'Source Code Pro', Consolas, 'Courier New', monospace;
}
.callout {
  border-left: 4px solid #ccc;
  border-radius: 0 6px 6px 0;
  padding: 0.75em 1em;
  margin: 1.2em 0;
  background: #f8f8f8;
}
.callout .callout-title {
  font-weight: 700;
  margin-bottom: 0.35em;
  display: flex;
  align-items: center;
  gap: 0.4em;
}
.callout-note    { border-color: #3b82f6; background: #eff6ff; }
.callout-note    .callout-title { color: #1d4ed8; }
.callout-tip     { border-color: #22c55e; background: #f0fdf4; }
.callout-tip     .callout-title { color: #15803d; }
.callout-warning { border-color: #f59e0b; background: #fffbeb; }
.callout-warning .callout-title { color: #b45309; }
.callout-danger  { border-color: #ef4444; background: #fef2f2; }
.callout-danger  .callout-title { color: #b91c1c; }
.mermaid {
  text-align: center;
  margin: 1.8em 0;
  overflow-x: auto;
  padding: 1em;
  background: #fafafa;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.mermaid svg { max-width: 100%; height: auto; }
.code-filename {
  background: #2d2d2d;
  color: #9cdcfe;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.8em;
  padding: 0.3em 1.4em;
  border-radius: 6px 6px 0 0;
  border-left: 3px solid #569cd6;
  margin-bottom: -1.4em;
}`;

