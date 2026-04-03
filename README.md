# obs-note-to-snippet

An Obsidian plugin that converts a note into a Squarespace-ready HTML snippet, pasted directly into a Squarespace Code Block.

## What it does

- Strips frontmatter and converts Markdown to HTML via `marked`
- Handles Obsidian-specific syntax: wikilinks, highlights, comments, tags, callouts, transclusions
- Wraps code blocks with Prism.js classes for syntax highlighting
- Extracts Mermaid diagrams and preserves them for rendering
- Optionally embeds a CSS block for styling code blocks, callouts and Mermaid diagrams
- Outputs a self-contained HTML snippet (no `<!DOCTYPE>`, no `<head>`) ready to paste into Squarespace

## Plugin Pipeline

The plugin uses a **sentinel-based pattern** to safely extract code blocks, process markdown, and restore code with proper HTML tags. See [SENTINEL_PATTERN.md](./SENTINEL_PATTERN.md) for technical details.

```text
User Export → Read File → Strip Frontmatter
  ↓
Extract Mermaid & Code Blocks (replace with sentinels)
  ↓
Apply Obsidian Converters (images, wikilinks, etc.)
  ↓
Parse Markdown to HTML (marked.js)
  ↓
Restore Code Blocks HTML (with word boundary fix)
  ↓
Restore Mermaid Diagrams → Fix Classes → Build Output
  ↓
Write HTML to squarespace-exports/
```

### Detailed Flow Diagram

```mermaid
flowchart TD
    Start(["📌 User Exports Note"]) --> ReadFile["📄 Read .md file"]
    ReadFile --> StripFM["🔨 Strip Frontmatter"]
    StripFM --> ExtractMerm["🎨 Extract Mermaid Blocks<br/>Replace with sentinels"]
    
    ExtractMerm --> ExtractCode["💻 Extract Code Blocks<br/>Fenced & Inline"]
    ExtractCode --> ExtractDecision{Both extractors<br/>successful?}
    
    ExtractDecision -->|No| Error1["❌ Return Error"]
    ExtractDecision -->|Yes| Converters["🔄 Apply 7 Obsidian Converters<br/>Images, Transclusions, Wikilinks<br/>Comments, Highlights, Tags, Callouts"]
    
    Converters --> Preprocess["📝 Preprocess Code Filenames<br/>Handle title: annotations"]
    Preprocess --> MarkedParse["📚 marked.parse()<br/>Markdown → HTML"]
    
    MarkedParse --> RestoreCode["🔧 Restore Code Blocks HTML<br/><b>WORD BOUNDARY FIX</b><br/>Fenced: &lt;pre&gt;&lt;code&gt;<br/>Inline: &lt;code&gt;"]
    
    RestoreCode --> RestoreMerm["🎨 Restore Mermaid Diagrams"]
    RestoreMerm --> FixClasses["🎯 Fix Code Fence Classes<br/>Add language tags for Prism"]
    
    FixClasses --> BuildOutput["🏗️ Build Output<br/>Inject CSS & Scripts"]
    BuildOutput --> WriteFile["💾 Write to<br/>squarespace-exports/"]
    
    WriteFile --> Success(["✅ Export Complete"])
    Error1 --> Failure(["❌ Export Failed"])
    
    style Start fill:#90EE90
    style Success fill:#90EE90
    style Failure fill:#FFB6C6
    style Error1 fill:#FFB6C6
    style ExtractCode fill:#87CEEB
    style RestoreCode fill:#FFD700
    style MarkedParse fill:#FFA500
    
    classDef processNode fill:#E6E6FA,stroke:#333,stroke-width:2px
    classDef decisionNode fill:#FFFACD,stroke:#333,stroke-width:2px
    classDef criticalNode fill:#FFE4E1,stroke:#FF6347,stroke-width:3px
    
    class ReadFile,StripFM,ExtractMerm,Converters,Preprocess,RestoreMerm,FixClasses,BuildOutput,WriteFile processNode
    class ExtractDecision decisionNode
    class RestoreCode criticalNode
```

## Note

This is a personal project built for my own workflow and published as an example. It is not actively developed or maintained, and is not listed in the Obsidian community plugin directory. Feel free to fork and adapt it for your own use.

## Usage

1. Open a note in Obsidian
2. Run the command **Export note to HTML snippet** (or click the ribbon icon)
3. The exported `.html` file is saved to the folder set in plugin settings (default: `squarespace-exports`)

## Setup

- Clone the repo
- `npm i` to install dependencies
- `npm run dev` to build in watch mode (output goes to your vault's plugin folder — update `PLUGIN_DIR` in `esbuild.config.mjs` to match your vault path)

## Squarespace one-time setup

Add the following to **Pages → Custom Code → Code Injection**:

**Header** — Prism stylesheet:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
```

**Footer** — Prism scripts (and Mermaid scripts if you use diagrams):

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
```

## Licence

MIT
