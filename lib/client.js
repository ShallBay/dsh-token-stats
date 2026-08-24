// @shallbay/dsh-token-stats — client half (browser plugin bundle).
//
// Adds a "Token 用量" entry to the web sidebar's footer actions row, which the
// sidebar shell renders above the Settings seat (slot 'sidebar.footer.action',
// declared by dsh-client-ui-sidebar). Clicking opens the token usage dashboard
// (/token-stats, served by this package's host half) in a new tab.
//
// Bundle format: the shell's __ModuleLoader__ CommonJS-style wrapper; only
// 'react' is required (available in the shell's module registry). No build
// step — this file is served raw at /plugins/@shallbay/dsh-token-stats/client.js.
window.__ModuleLoader__.load({
	id: "@shallbay/dsh-token-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { createElement } = react;

		// region sidebar footer action
		const CSS_TAG = "@shallbay/dsh-token-stats/sidebar-action";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".dsh-token-stats-action{display:inline-flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;padding:7px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;font-family:inherit}",
				".dsh-token-stats-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".dsh-token-stats-action:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,rgba(76,140,255,.9));outline-offset:-2px}",
				".dsh-token-stats-action .label{font-size:13px;font-weight:500;white-space:nowrap}"
			].join("");
			document.head.appendChild(tag);
		}

		/** Minimal bar-chart glyph (inline SVG, follows currentColor). */
		const TokenStatsIcon = () => createElement("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": true,
			style: { flex: "none" }
		},
			createElement("rect", { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1, fill: "currentColor" }),
			createElement("rect", { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: "currentColor", opacity: 0.75 }),
			createElement("rect", { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: "currentColor", opacity: 0.5 })
		);

		/**
		* Footer action trigger row. Owner passes only the column state; the wide
		* label is hidden in the 56px rail (icon-only), matching the shell's
		* other foot actions.
		* @param props - { wide: boolean } from the sidebar shell.
		*/
		function TokenStatsAction({ wide }) {
			const open = () => {
				window.open("/token-stats", "_blank", "noopener");
			};
			return createElement("button", {
				type: "button",
				className: "dsh-token-stats-action",
				title: "Token 用量",
				"aria-label": "Token 用量",
				onClick: open
			}, createElement(TokenStatsIcon), wide === true ? createElement("span", { className: "label" }, "Token 用量") : null);
		}
		// endregion

		// region plugin entry
		/** Required client services: the slot registry (provided by dsh-client-runtime). */
		const inject = ["slots"];

		/**
		* Register the sidebar foot action. The slot is declared by the sidebar
		* shell, so a plain register (wrapped in slots.inject for activation
		* ordering) is enough.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "token-stats",
				order: 0,
				inject: () => ({})
			}, TokenStatsAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
		// endregion
	}
});
