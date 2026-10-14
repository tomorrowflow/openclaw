import { html } from "lit";
import { property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../styles/sidebar-markdown.css";

class PluginMarkdown extends OpenClawLightDomElement {
  @property({ attribute: false }) markdown = "";

  override render() {
    // Plugin pages lack the chat's delegated copy-button listeners.
    return html`<div class="sidebar-markdown">
      ${unsafeHTML(toSanitizedMarkdownHtml(this.markdown, { codeBlockChrome: "none" }))}
    </div>`;
  }
}

if (!customElements.get("openclaw-plugin-markdown")) {
  customElements.define("openclaw-plugin-markdown", PluginMarkdown);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-markdown": PluginMarkdown;
  }
}
