import { Icon, type IconComponent, type SemanticIconName } from "../../lib/icons";

/** A semantic name renders from the active pack; a component (CloseIcon, …) renders as is. */
export type IconSource = SemanticIconName | IconComponent;

interface IconSlotProps {
  icon: IconSource;
  size?: number;
  compact?: boolean;
  className?: string;
  title?: string;
}

export function IconSlot({ icon, size = 16, compact, className, title }: IconSlotProps) {
  if (typeof icon === "string") return <Icon name={icon} size={size} compact={compact} className={className} title={title} />;
  const Component = icon;
  return <Component size={size} compact={compact} className={className} title={title} />;
}
