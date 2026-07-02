import type { PaperDialogElement } from "@polymer/paper-dialog";

import type { MoonCGAPIClient } from "../../api/api.client";

document.addEventListener(
	"click",
	(e) => {
		const mooncg = (window as any).mooncg as MoonCGAPIClient;
		const elWithDialogAttr = (e as any)
			.composedPath()[0]
			.closest("[mooncg-dialog]");
		if (elWithDialogAttr) {
			const dialogName = elWithDialogAttr.getAttribute("mooncg-dialog");
			const dialogId = `${mooncg.bundleName}_${dialogName as string}`;
			const dialogElement = window
				.top!.document.querySelector("ncg-dashboard")!
				.shadowRoot!.getElementById(dialogId) as PaperDialogElement;
			dialogElement.open();
		}
	},
	false,
);
