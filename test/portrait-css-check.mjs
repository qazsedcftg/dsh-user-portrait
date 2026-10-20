// CSS sanity: extract the panel stylesheet and check brace balance plus the
// official-token usage that the design alignment depends on.
import { CLIENT } from './_paths.mjs';
const client = await import("node:fs").then((fs) => fs.readFileSync(CLIENT, "utf8"));
const css = client.slice(client.indexOf("const CSS = `") + "const CSS = `".length, client.indexOf("`;\n\n    /**", client.indexOf("const CSS = `")));
const open = (css.match(/\{/g) ?? []).length;
const close = (css.match(/\}/g) ?? []).length;
import { check, finish } from './_harness.mjs';
check("panel stylesheet braces balance", open === close, `${open} vs ${close}`);
check("panel stylesheet declares the root", css.includes(".dup-root{"));
check("controls use the official radius scale", css.includes("var(--dsw-radius-sm)") && css.includes("var(--dsw-radius-md)"));
check("buttons use the official hover token", css.includes("var(--dsw-alias-interactive-bg-hover)"));
check("the danger hover token is used", css.includes("var(--dsw-alias-interactive-bg-hover-danger)"));
check("the tab indicator uses the raised surface", css.includes(".dup-tab-indicator") && css.includes("var(--dsw-alias-bg-layer-3)"));
check("chips tint with color-mix state tones", /color-mix\(in srgb,var\(--dsw-alias-state-(success|warn|error)-primary\)/.test(css));
check("fields use the settings-form geometry", css.includes("var(--dsw-alias-border-l4)") && css.includes("var(--dsw-alias-bg-layer-3)"));
check("no hard-coded hex colors", !/#[0-9a-fA-F]{3,6}\b/.test(css), (css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).join(","));

// The 编辑 control is a chip-sized button: same pill geometry as the confidence
// badge, filled with the primary colour, and the foreground token that renders as
// white on that fill.
const editChipRule = (css.match(/\.dup-edit-chip\{[^}]*\}/) ?? [""])[0];
check("the edit control has its own chip rule", editChipRule !== "", editChipRule);
check(
  "the edit chip matches the chip geometry",
  editChipRule.includes("border-radius:999px") && editChipRule.includes("padding:1px 8px") && editChipRule.includes("font-size:11px"),
  editChipRule,
);
check("the edit chip is filled with the primary colour", editChipRule.includes("var(--dsw-alias-button-primary-fill)"), editChipRule);
check(
  "the edit chip text uses the white foreground token",
  editChipRule.includes("var(--dsw-alias-label-primary-foreground)"),
  editChipRule,
);

// The blank-pane regression: a client half runs on the module table, whose only
// words are the platform seed. One `require` outside that set throws while the
// factory is evaluated, the slot service drops the entry, and the pane renders
// empty — with nothing in the Host log to explain it. Every specifier in the
// file must therefore be a seed word.
const SEED_WORDS = new Set(["react"]);
const requires = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
check("the client half imports React", requires.includes("react"), requires);
check(
  "every require in the client half is a platform seed word",
  requires.every((spec) => SEED_WORDS.has(spec)),
  requires.filter((spec) => !SEED_WORDS.has(spec)),
);
check("it does not require the primitives package", !requires.some((spec) => spec.includes("ui-primitives")), requires);
check("it does not require a styles module", !requires.includes("styles"), requires);
check(
  "the stylesheet is owned and stamped by the plugin",
  client.includes("document.createElement('style')") &&
    client.includes("tag.dataset.plugin = PLUGIN_ID") &&
    client.includes("tag.dataset.pluginCss = STYLE_TAG_ID"),
);
check(
  "icons are inline official SVG artwork",
  client.includes("const GLYPHS = {") &&
    client.includes("'http://www.w3.org/2000/svg'") &&
    client.includes("function glyph(name, size = 14)"),
);
finish('CSS CHECKS PASSED');
