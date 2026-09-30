import type { ReactNode } from "react";
import { Button } from "../ui";

interface SmallButtonProps {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}

/** The small inline action of the sync panels and notices: Button size="sm". */
export default function SmallButton({ children, onClick, primary = false, disabled }: SmallButtonProps) {
  return (
    <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}
