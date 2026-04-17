interface FieldProps {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export default function Field({ label, required, className, children }: FieldProps) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-ink-secondary mb-1">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}
