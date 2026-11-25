/** A modal dialog has the keyboard: nothing under it can take the focus, and Esc is the dialog's. */
export const modalOpen = (): boolean => document.querySelector("dialog:modal") !== null;
