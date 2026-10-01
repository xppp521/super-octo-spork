/**
 * dsh-session-delete — browser half.
 *
 * Contributes one `sidebar.workspaces.session.menu.item` row (and one
 * `sidebar.workspaces.session.row.action` hover button) that really deletes a
 * session, plus the `shell.overlay` confirmation dialog and result toast.
 * The deletion itself lives in the host half and is reached over one exact HTTP
 * route, exactly the way other browser plugins talk to their host half.
 *
 * Shape note: this file is a hand-written bundle. The loader reads the file
 * named by the package's `exports["./client"]` and calls
 * `window.__ModuleLoader__.load({ id, factory })`, where `id` MUST equal the
 * package name and the factory MUST return a Cordis plugin object. Only the
 * frozen baseline module table may be `require`d.
 */
window.__ModuleLoader__.load({ id: "dsh-session-delete", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	const React = require("react");
	const jsxRuntime = require("react/jsx-runtime");
	const jsx = jsxRuntime.jsx;
	const jsxs = jsxRuntime.jsxs;
	const Fragment = React.Fragment;
	/** Optional: the shared primitives module. Every use below degrades to plain markup. */
	let primitives = null;
	try {
		primitives = require("@deepseek-ai/dsh-client-ui-primitives");
	} catch (error) {
		primitives = null;
	}

	/** Cordis plugin identity (the package name, distinct from the loader entry id). */
	const name = "dsh-session-delete";
	/** Client services this plugin needs: slot registry, session list, dictionaries. */
	const inject = ["slots", "sessions", "locale"];
	/** Dictionary namespace owned by this plugin. */
	const NS = "session-delete";
	/** The host half's deletion route. */
	const ROUTE = "/dsh-session-delete/delete";

	const zh = {
		"menu.deleteSession": "删除会话",
		"actions.delete": "删除会话",
		"confirm.title": "永久删除这个会话？",
		"confirm.desc": "“{title}”的对话记录、侧栏缓存和工作区登记都会被永久删除，无法恢复。",
		"confirm.action": "永久删除",
		"confirm.cancel": "取消",
		"confirm.pending": "正在删除…",
		"toast.deleted": "会话已删除，不可恢复",
		"error.live": "这个会话正在运行，无法删除。",
		"error.generic": "删除失败：{message}"
	};
	const en = {
		"menu.deleteSession": "Delete session",
		"actions.delete": "Delete session",
		"confirm.title": "Permanently delete this session?",
		"confirm.desc": "The conversation log, sidebar cache, and workspace record of “{title}” will be deleted permanently. This cannot be undone.",
		"confirm.action": "Delete permanently",
		"confirm.cancel": "Cancel",
		"confirm.pending": "Deleting…",
		"toast.deleted": "Session deleted — this cannot be undone",
		"error.live": "This session is running and cannot be deleted.",
		"error.generic": "Deletion failed: {message}"
	};

	/**
	* Resolve one host path against the page the UI is served from.
	* @param path - the route path, with or without a leading slash.
	* @returns the pathname to fetch.
	*/
	function api(path) {
		const relative = path.replace(/^\/+/, "");
		if (typeof document === "undefined" || typeof document.baseURI !== "string") return `/${relative}`;
		try {
			return new URL(relative, document.baseURI).pathname;
		} catch (error) {
			return `/${relative}`;
		}
	}

	/**
	* A minimal observable in the shape the slot system injects (`getSnapshot` +
	* `subscribe`), so this plugin needs no state package.
	* @param initial - the initial snapshot.
	* @returns the store.
	*/
	function createStore(initial) {
		let value = initial;
		const listeners = new Set();
		return {
			getSnapshot: () => value,
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			set(next) {
				if (Object.is(next, value)) return;
				value = next;
				for (const listener of [...listeners]) listener();
			}
		};
	}

	/**
	* Ask the host half to delete one session.
	* @param sessionId - the session to delete.
	* @returns the host's success payload.
	* @throws an Error carrying the host's message when the deletion was refused.
	*/
	async function postDelete(sessionId) {
		const response = await fetch(api(ROUTE), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId })
		});
		let payload = null;
		try {
			payload = await response.json();
		} catch (error) {
			payload = null;
		}
		if (!response.ok || payload === null || payload.ok !== true) {
			const error = new Error(payload?.error ?? `HTTP ${response.status}`);
			error.code = payload?.code;
			throw error;
		}
		return payload;
	}

	/** A trash glyph when the primitives module provides one, else nothing. */
	function TrashIcon(props) {
		if (primitives?.IconTrashOutlineRegular === undefined) return null;
		return jsx(primitives.IconTrashOutlineRegular, { size: props?.size ?? 14 });
	}

	const iconButtonStyle = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		background: "none",
		border: "none",
		padding: "2px",
		margin: "0",
		color: "inherit",
		cursor: "pointer",
		borderRadius: "4px"
	};
	const fallbackItemStyle = {
		display: "block",
		width: "100%",
		textAlign: "left",
		background: "none",
		border: "none",
		padding: "6px 10px",
		color: "inherit",
		cursor: "pointer",
		font: "inherit"
	};

	/**
	* The `...` menu row. Sits after the shipped actions (`order` 500).
	* @param props - row identity, the menu open-state hook, and the plugin share.
	* @returns the row.
	*/
	function DeleteSessionMenuItem(props) {
		const { sessionId, displayTitle } = props;
		const [, setMenuOpen] = props.useMenuOpenState();
		const label = props.t("menu.deleteSession");
		const onSelect = () => {
			setMenuOpen(false);
			props.deleteSession(sessionId, displayTitle);
		};
		if (primitives?.MenuItemButton !== undefined) {
			return jsx(primitives.MenuItemButton, {
				icon: jsx(TrashIcon, {}),
				onSelect,
				children: label
			});
		}
		return jsx("button", {
			type: "button",
			role: "menuitem",
			style: fallbackItemStyle,
			onClick: onSelect,
			children: label
		});
	}

	/**
	* The hover button, so one click on the row is enough to reach the confirm step.
	* @param props - row identity and the plugin share.
	* @returns the button.
	*/
	function DeleteSessionRowButton(props) {
		const { sessionId, displayTitle } = props;
		const label = props.t("actions.delete");
		const button = jsx("button", {
			type: "button",
			style: iconButtonStyle,
			"aria-label": label,
			title: label,
			onClick: () => {
				props.deleteSession(sessionId, displayTitle);
			},
			children: jsx(TrashIcon, {})
		});
		if (primitives?.Tooltip !== undefined) {
			return jsx(primitives.Tooltip, {
				label,
				side: "bottom",
				align: "end",
				delayMs: 500,
				children: button
			});
		}
		return button;
	}

	/**
	* The `shell.overlay` entry: one dialog while a deletion is pending.
	* @param props - the request hook, the hop, the settlement, and the locale seat.
	* @returns the open dialog, or null.
	*/
	function DeleteConfirmDialog(props) {
		const request = props.useDeleteRequest((state) => state);
		if (request === null || primitives?.Modal === undefined) return null;
		return jsx(ConfirmDeleteForm, {
			request,
			confirmDelete: props.confirmDelete,
			settleDelete: props.settleDelete,
			t: props.t
		}, request.sessionId);
	}

	/**
	* One request's dialog: in-flight and error state die with it.
	* @param props - request, host hop, settlement, locale seat.
	* @returns the dialog.
	*/
	function ConfirmDeleteForm(props) {
		const { request, confirmDelete, settleDelete, t } = props;
		const [busy, setBusy] = React.useState(false);
		const [error, setError] = React.useState(null);
		const close = () => {
			if (!busy) settleDelete();
		};
		const confirm = () => {
			setBusy(true);
			setError(null);
			confirmDelete(request.sessionId).then(() => {
				setBusy(false);
				settleDelete();
			}).catch((reason) => {
				setBusy(false);
				const message = reason instanceof Error ? reason.message : String(reason);
				setError(t(reason?.code === "session-live" ? "error.live" : "error.generic", { message }));
			});
		};
		const fallbackButton = (props) => jsx("button", {
			type: "button",
			disabled: props.disabled === true,
			onClick: props.onClick,
			children: props.children
		});
		const Button = primitives.Button ?? fallbackButton;
		const Modal = primitives.Modal;
		return jsx(Modal, {
			open: true,
			onClose: close,
			closeLabel: t("confirm.cancel"),
			title: t("confirm.title"),
			description: t("confirm.desc", { title: request.displayTitle ?? request.sessionId }),
			footer: jsxs(Fragment, { children: [
				jsx(Button, { variant: "outline", disabled: busy, onClick: close, children: t("confirm.cancel") }),
				jsx(Button, { variant: "outline", disabled: busy, onClick: confirm, children: t("confirm.action") })
			] }),
			children: [
				busy && jsx("div", { role: "status", children: t("confirm.pending") }),
				error !== null && jsx("div", { role: "alert", children: error })
			]
		});
	}

	/**
	* The `shell.overlay` entry: one result toast after a successful deletion.
	* @param props - the notice hook and its dismissal.
	* @returns the toast, or null.
	*/
	function DeleteResultToast(props) {
		const notice = props.useNotice((state) => state);
		if (notice === null || primitives?.Toast === undefined) return null;
		return jsx(primitives.Toast, {
			text: notice.text,
			icon: jsx(TrashIcon, {}),
			onDone: () => {
				props.dismissNotice();
			}
		});
	}

	/**
	* Register the browser contributions.
	* @param ctx - the client root context.
	*/
	function apply(ctx) {
		const pending = createStore(null);
		const notice = createStore(null);
		const sessions = ctx.get("sessions");
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-delete: dictionaries");
		/** Dictionaries for code paths outside a slot render (there is no `t` prop there). */
		let translate = null;
		try {
			translate = ctx.locale.bind(NS);
		} catch (error) {
			translate = null;
		}
		const T = (key, params) => {
			if (typeof translate === "function") return translate(key, params);
			return zh[key] ?? key;
		};

		/** Delete one session on the host, then read the list back and drop its row. */
		const runDelete = async (sessionId) => {
			const payload = await postDelete(sessionId);
			notice.set({
				sessionId,
				text: `${payload.displayTitle ?? sessionId} — ${T("toast.deleted")}`
			});
			// Reread the list FIRST, then drop the row. `refreshList()` resets the
			// pending mutation list when it starts, so a removal recorded before the
			// refresh would be discarded and the row would come back from the
			// baseline — the host can still be listing a session it merely holds
			// loaded. `handleSessionRemoved` is the very handler the host's
			// `api-session/removed` relay calls, so both paths agree.
			try {
				await sessions?.refresh?.();
			} catch (error) {
				console.warn("dsh-session-delete: session list refresh failed", error);
			}
			if (typeof sessions?.handleSessionRemoved === "function") {
				try {
					sessions.handleSessionRemoved(sessionId);
				} catch (error) {
					console.warn("dsh-session-delete: local row removal failed", error);
				}
			}
			return payload;
		};

		/**
		* Entry point shared by both contributions. With the Modal primitive
		* available this opens the confirmation dialog; otherwise it falls back to
		* the browser's own confirm so the feature still works.
		*/
		const deleteSession = (sessionId, displayTitle) => {
			if (primitives?.Modal !== undefined) {
				pending.set({ sessionId, displayTitle: displayTitle ?? sessionId });
				return;
			}
			const message = `Delete session ${displayTitle ?? sessionId} permanently? This cannot be undone.`;
			if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(message)) return;
			runDelete(sessionId).catch((reason) => {
				console.warn("dsh-session-delete:", reason);
				if (typeof window !== "undefined" && typeof window.alert === "function") {
					window.alert(reason instanceof Error ? reason.message : String(reason));
				}
			});
		};

		const menuInjected = () => ({ deleteSession });
		const rowInjected = () => ({ deleteSession });
		const dialogInjected = () => ({
			hooks: { deleteRequest: pending },
			confirmDelete: runDelete,
			settleDelete: () => {
				pending.set(null);
			}
		});
		const toastInjected = () => ({
			hooks: { notice },
			dismissNotice: () => {
				notice.set(null);
			}
		});

		ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
			name: "sidebar.workspaces.session.menu.item",
			id: "session-delete",
			order: 500,
			locale: NS,
			inject: menuInjected
		}, DeleteSessionMenuItem));
		ctx.slots.inject("sidebar.workspaces.session.row.action", () => ctx.slots.register({
			name: "sidebar.workspaces.session.row.action",
			id: "session-delete",
			order: 300,
			locale: NS,
			inject: rowInjected
		}, DeleteSessionRowButton));
		ctx.slots.inject("shell.overlay", function* () {
			yield ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-session-delete-confirm",
				locale: NS,
				inject: dialogInjected
			}, DeleteConfirmDialog);
			yield ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-session-delete-toast",
				locale: NS,
				inject: toastInjected
			}, DeleteResultToast);
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
