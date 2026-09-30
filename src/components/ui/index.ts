// Shared UI primitives (docs/VISUAL_REDESIGN.md section 4).
export { cx } from "./cx";
export { IconSlot, type IconSource } from "./IconSlot";
export { useLayer, useEscapeLayer, type LayerOptions } from "./layers";

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { IconButton, type IconButtonProps, type IconButtonSize } from "./IconButton";

export { TextInput, type TextInputProps } from "./TextInput";
export { Textarea, type TextareaProps } from "./Textarea";
export { PasswordInput, type PasswordInputProps } from "./PasswordInput";
export { SearchInput, type SearchInputProps } from "./SearchInput";
export { FormField, type FormFieldProps } from "./FormField";
export { Select, type SelectProps } from "./Select";

export { Checkbox, type CheckboxProps } from "./Checkbox";
export { Radio, RadioGroup, type RadioProps, type RadioGroupProps } from "./Radio";
export { Switch, type SwitchProps } from "./Switch";
export { Slider, type SliderProps } from "./Slider";

export { Tabs, TabPanel, tabId, tabPanelId, type TabItem, type TabsProps, type TabsVariant, type TabPanelProps } from "./Tabs";
export { SegmentedControl, type SegmentOption, type SegmentedControlProps } from "./SegmentedControl";
export { NavList, type NavEntry, type NavGroup, type NavItem, type NavLabel, type NavListProps } from "./NavList";

export { Dialog, DialogBody, DialogFooter, DialogHeader, type DialogLayer, type DialogProps, type DialogSize, type DialogTone } from "./Dialog";
export { Popover, type PopoverPlacement, type PopoverProps } from "./Popover";
export { Menu, MenuHeader, MenuItem, MenuSeparator, type MenuItemProps, type MenuProps } from "./Menu";

export { Badge, CountBadge, type BadgeProps, type BadgeTone, type CountBadgeProps } from "./Badge";
export { Kbd } from "./Kbd";
export { Spinner, type SpinnerProps } from "./Spinner";

export { Card } from "./Card";
export { ChoiceCard, ChoiceGroup, type ChoiceCardProps, type ChoiceGroupProps } from "./ChoiceCard";
export { Callout, type CalloutProps, type CalloutTone } from "./Callout";
export { Banner, type BannerAction, type BannerProps, type BannerTone } from "./Banner";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { SectionHeader, type SectionHeaderProps } from "./SectionHeader";
export { SettingsRow, type SettingsRowProps } from "./SettingsRow";

export { ListRow, type ListRowProps, type RowLeadingContent } from "./ListRow";
export { TREE_INDENT_PX, TreeRow, type TreeRowProps } from "./TreeRow";
export { ToastCard, type ToastCardAction, type ToastCardProgress, type ToastCardProps, type ToastCardType } from "./ToastCard";
