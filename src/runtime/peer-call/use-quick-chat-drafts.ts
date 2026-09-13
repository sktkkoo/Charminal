import { useRef, useState } from "react";

/** Keep work text out of a new call, including its pre-admission waiting state. */
export function useQuickChatDrafts(callOwner: string | null) {
  const currentOwner = useRef(callOwner);
  currentOwner.current = callOwner;
  const [workDraft, setWorkDraft] = useState("");
  const [callDraft, setCallDraft] = useState<{ owner: string | null; text: string }>({
    owner: null,
    text: "",
  });
  const value =
    callOwner === null ? workDraft : callDraft.owner === callOwner ? callDraft.text : "";
  const setValue = (text: string) => {
    if (currentOwner.current !== callOwner) return;
    if (callOwner === null) setWorkDraft(text);
    else setCallDraft({ owner: callOwner, text });
  };
  return { owner: callOwner, value, setValue };
}
