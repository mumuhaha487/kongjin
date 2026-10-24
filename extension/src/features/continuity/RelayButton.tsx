import "./relay-button.css";
import { History } from "lucide-react";
import { useStore } from "../../app/store";
import { openContinuity, useContinuity } from "./bridge";
// This entry intentionally does not import the panel, database or resume computation.
export function RelayButton() {
  const unread = useContinuity((s) => s.inbox.some((i) => !i.read));
  return (
    <button
      className="icon-button relay-trigger"
      aria-label="接力"
      onClick={() => {
        useStore.setState({ settingsOpen: false });
        openContinuity();
      }}
    >
      <History size={20} />
      {unread && <i className="relay-unread" />}
    </button>
  );
}
