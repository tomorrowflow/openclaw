import { MarkdownHtml } from "../components/solid/markdown-html.tsx";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import "../styles/sidebar-markdown.css";

export type PluginMarkdownProps = { markdown: string };

defineSolidBridge<PluginMarkdownProps>(
  "openclaw-plugin-markdown",
  // Plugin pages lack the chat's delegated copy-button listeners.
  (props) => (
    <MarkdownHtml
      class="sidebar-markdown"
      markdown={props.markdown}
      options={{ codeBlockChrome: "none" }}
    />
  ),
  { properties: { markdown: { default: "", attribute: false } } },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-markdown": SolidBridgeElement<PluginMarkdownProps>;
  }
}
