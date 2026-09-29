// Finds the numbered choices in an agent's approval or question dialog, such as
//   ❯ 1. Yes
//     2. Yes, and don't ask again for this command
//     3. No, and tell Claude what to do differently (esc)
// so the UI can offer them as buttons that press the matching number key.

export interface DialogOption {
  key: string;
  label: string;
  /** The option the dialog's cursor is on. */
  selected: boolean;
}

// Only the bottom of the screen holds the live dialog; earlier numbered lists are output.
const SCAN_LINES = 40;
const OPTION = /^(?:([❯›>▸▶→*])\s*)?(\d{1,2})[.)]\s+(\S.*?)$/;
// Box-drawing borders that some TUIs draw around dialogs.
const BORDER = /^[\s│┃|╎╏]+|[\s│┃|╎╏]+$/g;

export function parseDialogOptions(screen: string): DialogOption[] {
  const lines = screen.split("\n").slice(-SCAN_LINES);
  let best: DialogOption[] = [];
  let run: DialogOption[] = [];
  for (const raw of lines) {
    const line = raw.replace(BORDER, "");
    const m = OPTION.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    const option = { key: String(n), label: m[3].trim(), selected: !!m[1] };
    if (n === 1) run = [option];
    else if (run.length > 0 && n === run.length + 1) run.push(option);
    else run = [];
    if (run.length >= 2) best = [...run];
  }
  return best;
}
