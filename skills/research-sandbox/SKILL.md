---
name: research-sandbox
description: "Research agent sandbox with web extraction, document processing, media tools, and headless browser. Use when: (1) scraping or crawling websites for content, (2) downloading or processing videos/audio, (3) extracting text from PDFs, images (OCR), or office docs, (4) converting between document formats, (5) processing structured data (CSV, JSON, YAML, XML, SQL), (6) any research task that needs network access and CLI tools in an isolated container. NOT for: simple web fetches (use the browser tool), coding tasks (use coding-agent), quick single-URL reads (use exec with curl). Requires the research sandbox Docker image."
metadata: { "openclaw": { "emoji": "🔬", "requires": { "bins": ["docker"] } } }
---

# Research Sandbox

An isolated Docker sandbox pre-loaded with CLI tools for web research, content extraction, document processing, media handling, and data wrangling. All commands run inside the `openclaw-sandbox-research:bookworm-slim` container as an unprivileged `sandbox` user.

## Setup

Build the image (one-time):

```bash
scripts/sandbox-research-setup.sh
```

Configure the agent to use it:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all", // or "non-main"
        docker: {
          image: "openclaw-sandbox-research:bookworm-slim",
          network: "bridge", // research needs internet access
        },
      },
    },
  },
}
```

Or for a dedicated research agent only:

```json5
{
  agents: {
    list: [
      {
        id: "research",
        sandbox: {
          docker: {
            image: "openclaw-sandbox-research:bookworm-slim",
            network: "bridge",
          },
        },
      },
    ],
  },
}
```

## When to Use This Sandbox

Spawn a research sub-agent when the task involves:

- Crawling multiple pages or an entire site
- Downloading video/audio for transcription or analysis
- Batch-processing PDFs, images, or office documents
- Converting between document formats (HTML, PDF, DOCX, Markdown)
- Running OCR on scanned documents or images
- Extracting and transforming structured data (CSV, JSON, YAML, XML)
- Any multi-step research pipeline that combines several tools below

For a quick single fetch, prefer the built-in browser or exec tool directly.

---

## Tool Reference

### Web Crawling and Content Extraction

#### crwl (crawl4ai)

AI-optimized web crawler. Outputs clean markdown with optional LLM extraction.

```bash
# Crawl a single page and get markdown
crwl crawl https://example.com

# Crawl with a question (focused extraction)
crwl crawl https://example.com --question "What is the main topic?"

# Verbose mode for debugging
crwl crawl https://example.com --verbose
```

Output is JSON with `markdown.raw_markdown`, `markdown.fit_markdown`, and metadata.

#### trafilatura

Extract article text from web pages. Best for news articles, blog posts, and documentation.

```bash
# Extract text from a URL
trafilatura -u "https://example.com/article"

# Extract with metadata (title, author, date)
trafilatura -u "https://example.com/article" --json

# Process a local HTML file
trafilatura -i page.html

# Extract from multiple URLs (one per line)
trafilatura --input-file urls.txt
```

#### lynx

Text-mode browser. Fast, renders page structure including tables and lists.

```bash
# Dump page as plain text
lynx -dump -nolist "https://example.com"

# Dump with numbered links
lynx -dump "https://example.com"

# Extract just the text, no formatting
lynx -dump -nolist -nonumbers "https://example.com"
```

### HTTP and Downloads

#### httpie

Human-friendly HTTP client. Cleaner output than curl for API exploration.

```bash
# GET request (default)
http https://api.example.com/data

# POST JSON
http POST https://api.example.com/data name=value

# Headers only
http --print=h HEAD https://example.com

# Download a file
http --download https://example.com/file.pdf
```

#### aria2c

High-speed download accelerator with multi-connection support.

```bash
# Download a file (16 connections)
aria2c -x 16 "https://example.com/large-file.zip"

# Download multiple URLs from a file
aria2c -i urls.txt -x 16

# Download with filename
aria2c -o output.pdf "https://example.com/document"
```

#### wget

Standard recursive downloader.

```bash
# Download a file
wget "https://example.com/file.pdf"

# Mirror a site (careful with depth)
wget --mirror --convert-links --page-requisites -l 2 "https://example.com"

# Download all PDFs from a page
wget -r -l 1 -A "*.pdf" "https://example.com/docs/"
```

---

### Video and Audio

#### yt-dlp

Download video/audio from YouTube and 1000+ sites.

```bash
# Download video (best quality)
yt-dlp "https://youtube.com/watch?v=VIDEO_ID"

# Audio only (best quality, convert to mp3)
yt-dlp -x --audio-format mp3 "https://youtube.com/watch?v=VIDEO_ID"

# Extract metadata only (no download)
yt-dlp --dump-json "https://youtube.com/watch?v=VIDEO_ID"

# List available formats
yt-dlp -F "https://youtube.com/watch?v=VIDEO_ID"

# Download subtitles only
yt-dlp --write-sub --sub-lang en --skip-download "https://youtube.com/watch?v=VIDEO_ID"

# Download auto-generated subtitles (useful for transcription)
yt-dlp --write-auto-sub --sub-lang en --skip-download "https://youtube.com/watch?v=VIDEO_ID"

# Download playlist metadata
yt-dlp --flat-playlist --dump-json "https://youtube.com/playlist?list=PLAYLIST_ID"
```

#### ffmpeg

Media processing swiss-army knife. Used by yt-dlp internally.

```bash
# Extract audio from video
ffmpeg -i video.mp4 -vn -acodec mp3 audio.mp3

# Convert video format
ffmpeg -i input.mkv -c copy output.mp4

# Extract a clip (from 1:00 to 2:30)
ffmpeg -i video.mp4 -ss 00:01:00 -to 00:02:30 -c copy clip.mp4

# Extract frames as images (1 frame per second)
ffmpeg -i video.mp4 -vf fps=1 frame_%04d.png

# Get media info
ffprobe -v quiet -print_format json -show_format -show_streams video.mp4
```

---

### Document Processing

#### pandoc

Universal document converter. Supports 40+ formats.

```bash
# HTML to Markdown
pandoc -f html -t markdown -o output.md input.html

# Markdown to PDF (requires LaTeX or wkhtmltopdf)
pandoc -f markdown -t html -o output.html input.md

# DOCX to Markdown
pandoc -f docx -t markdown -o output.md input.docx

# Convert URL content to markdown
curl -s "https://example.com" | pandoc -f html -t markdown

# Extract plain text from any supported format
pandoc -t plain input.docx
```

#### pdftotext (poppler-utils)

Fast PDF text extraction. Part of poppler-utils.

```bash
# Extract text from PDF
pdftotext document.pdf -

# Extract specific pages
pdftotext -f 1 -l 5 document.pdf -

# Preserve layout
pdftotext -layout document.pdf -

# Get PDF metadata
pdfinfo document.pdf
```

#### tesseract

OCR engine. Extracts text from images and scanned PDFs.

```bash
# OCR an image
tesseract image.png stdout

# OCR with language
tesseract image.png stdout -l eng

# OCR to searchable PDF
tesseract scanned.png output pdf

# OCR to TSV (with confidence scores)
tesseract image.png stdout tsv
```

For scanned PDFs, first convert pages to images with ImageMagick, then OCR:

```bash
convert -density 300 scanned.pdf page_%d.png
for f in page_*.png; do tesseract "$f" "${f%.png}" -l eng; done
cat page_*.txt > full_text.txt
```

#### catdoc

Extract text from legacy Microsoft Office formats (.doc, .xls).

```bash
# Extract text from .doc
catdoc document.doc

# Extract text from .xls
xls2csv spreadsheet.xls
```

---

### Media Analysis

#### ImageMagick (convert/identify)

Image processing and conversion.

```bash
# Get image info
identify image.png

# Resize image
convert image.png -resize 800x600 resized.png

# Convert format
convert document.pdf[0] first_page.png    # first page of PDF to PNG

# Create thumbnail
convert image.png -thumbnail 200x200 thumb.png

# Batch convert
for f in *.webp; do convert "$f" "${f%.webp}.png"; done
```

#### exiftool

Read/write metadata from images, video, audio, and documents.

```bash
# Read all metadata
exiftool image.jpg

# Read specific fields
exiftool -Title -Author -CreateDate document.pdf

# Extract GPS coordinates
exiftool -gpslatitude -gpslongitude photo.jpg

# JSON output
exiftool -json image.jpg
```

---

### Data Wrangling

#### jq

JSON processor. Already in base image.

```bash
# Pretty-print
echo '{"a":1}' | jq .

# Extract field
cat data.json | jq '.results[].name'

# Filter and transform
cat data.json | jq '[.items[] | select(.score > 80) | {name, score}]'

# Convert JSON lines to array
cat records.jsonl | jq -s '.'
```

#### yq

YAML/TOML processor (same syntax as jq).

```bash
# Read YAML field
yq '.metadata.name' config.yaml

# Convert YAML to JSON
yq -o=json '.' config.yaml

# Convert JSON to YAML
yq -P '.' data.json

# Edit YAML in place
yq -i '.version = "2.0"' config.yaml
```

#### miller (mlr)

Tabular data processor for CSV, JSON, and other formats.

```bash
# View CSV as table
mlr --csv --opprint cat data.csv

# Sort by column (descending)
mlr --csv sort -nr score data.csv

# Filter rows
mlr --csv filter '$score > 80' data.csv

# Add computed column
mlr --csv put '$ratio = $score / $total' data.csv

# Group-by statistics
mlr --csv stats1 -a mean,min,max -f score -g category data.csv

# Convert CSV to JSON
mlr --icsv --ojson cat data.csv
```

#### sqlite3

SQL database engine for structuring and querying data.

```bash
# Import CSV into a table
sqlite3 research.db <<SQL
.mode csv
.import data.csv results
SELECT category, COUNT(*), AVG(score) FROM results GROUP BY category;
SQL

# Query with headers
sqlite3 -header -column research.db "SELECT * FROM results LIMIT 10;"

# Export query results as CSV
sqlite3 -header -csv research.db "SELECT * FROM results;" > export.csv
```

#### csvkit

CSV inspection and processing toolkit.

```bash
# Pretty-print CSV
csvlook data.csv

# Column statistics
csvstat data.csv

# SQL query on CSV
csvsql --query "SELECT name, score FROM data WHERE score > 80" data.csv

# Filter rows by pattern
csvgrep -c name -m "alice" data.csv

# Convert Excel to CSV
in2csv spreadsheet.xlsx > data.csv

# Stack multiple CSVs
csvstack file1.csv file2.csv > combined.csv
```

#### xmlstarlet

XML parser and transformer.

```bash
# Extract values with XPath
xmlstarlet sel -t -v "//item/title" feed.xml

# List elements
xmlstarlet el feed.xml

# Transform XML
xmlstarlet sel -t -m "//entry" -v "title" -o ": " -v "link/@href" -n feed.xml

# Validate XML
xmlstarlet val document.xml
```

---

### Headless Browser (Playwright)

For JavaScript-rendered pages that static tools cannot extract.

```bash
# Quick page scrape via Node one-liner
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log(await page.content());        // full rendered HTML
  // or: console.log(await page.textContent('body'));  // text only
  // or: console.log(await page.title());
  await browser.close();
})();
"
```

Use Playwright when:

- The page requires JavaScript to render content (SPAs, lazy-loaded articles)
- You need to interact with the page (click, scroll, fill forms)
- Static tools (trafilatura, lynx, curl) return empty or incomplete content

```bash
# Screenshot a page
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  await browser.close();
})();
"

# Generate PDF from a web page
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.pdf({ path: 'page.pdf', format: 'A4' });
  await browser.close();
})();
"
```

---

### Archives

#### 7z

Universal archive tool.

```bash
# Extract any archive
7z x archive.zip
7z x archive.7z
7z x archive.tar.gz

# List archive contents
7z l archive.zip

# Create archive
7z a output.7z files/
```

#### unzip

Fast ZIP extraction.

```bash
# Extract
unzip archive.zip -d output_dir/

# List contents
unzip -l archive.zip
```

---

## Research Workflow Examples

### Extract article text from multiple URLs

```bash
# Create URL list
cat > urls.txt << 'EOF'
https://example.com/article-1
https://example.com/article-2
https://example.com/article-3
EOF

# Batch extract
trafilatura --input-file urls.txt --json > articles.jsonl
```

### Download YouTube video, extract audio, get subtitles

```bash
# Get subtitles and metadata
yt-dlp --write-auto-sub --sub-lang en --skip-download --dump-json \
  "https://youtube.com/watch?v=VIDEO_ID" > metadata.json

# Download audio only
yt-dlp -x --audio-format mp3 -o "audio.%(ext)s" "https://youtube.com/watch?v=VIDEO_ID"
```

### Crawl a site and build a research database

```bash
# Crawl pages
for url in $(cat urls.txt); do
  crwl crawl "$url" 2>/dev/null | jq -r '.markdown.raw_markdown' > "$(echo $url | md5sum | cut -c1-8).md"
done

# Or use trafilatura for batch extraction
trafilatura --input-file urls.txt --json | \
  jq -r '[.title, .text, .url] | @csv' > corpus.csv

# Import into SQLite for querying
sqlite3 research.db <<SQL
.mode csv
.import corpus.csv articles
SELECT COUNT(*), AVG(LENGTH(text)) FROM articles;
SQL
```

### OCR a scanned PDF

```bash
# Convert PDF pages to images
convert -density 300 scanned.pdf page_%d.png

# OCR each page
for f in page_*.png; do
  tesseract "$f" "${f%.png}" -l eng
done

# Combine
cat page_*.txt > full_document.txt
```

### Convert and analyze a dataset

```bash
# Excel to CSV
in2csv report.xlsx > report.csv

# Quick stats
csvstat report.csv

# Filter and export
csvsql --query "SELECT department, SUM(amount) as total
  FROM report GROUP BY department ORDER BY total DESC" report.csv | csvlook
```
