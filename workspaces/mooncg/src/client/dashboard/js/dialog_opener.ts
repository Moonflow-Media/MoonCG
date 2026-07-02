import type { MoonCGAPIClient } from "../../api/api.client";

document.addEventListener(
	"click",
	(e) => {
		const mooncg = (window as any).mooncg as MoonCGAPIClient;
		const elWithDialogAttr = (e as any)
			.composedPath()[0]
			.closest("[mooncg-dialog]");
		if (elWithDialogAttr) {
			const dialogName = elWithDialogAttr.getAttribute(
				"mooncg-dialog",
			) as string;
			const dialogElement = mooncg.getDialog(dialogName);
			dialogElement?.open();
		}
	},
	false,
);
