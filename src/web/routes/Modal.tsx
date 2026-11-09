import { type ReactNode, useEffect, useRef } from "react";

/** A form over the page, on the browser's own <dialog>: Escape closes it and focus stays inside. */
export const Modal = ({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="card m-auto w-full max-w-md text-left text-ink backdrop:bg-black/50"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; one inside lands on a child.
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <h2 className="mb-0">{title}</h2>
        <button type="button" className="quiet-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
};
