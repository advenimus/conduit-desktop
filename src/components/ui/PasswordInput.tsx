import { useState } from "react";
import { IconButton } from "./IconButton";
import { TextInput, type TextInputProps } from "./TextInput";

export type PasswordInputProps = Omit<TextInputProps, "type" | "trailing">;

export function PasswordInput(props: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <TextInput
      {...props}
      type={show ? "text" : "password"}
      trailing={
        <IconButton size="sm" icon={show ? "eyeOff" : "eye"} label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)} />
      }
    />
  );
}
