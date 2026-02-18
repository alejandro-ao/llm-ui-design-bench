"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ModelOption {
  modelId: string;
  label: string;
  provider: string;
  vendor: string;
  sourceType: "model" | "agent" | "baseline";
}

interface ModelSelectorProps {
  options: ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ options, value, onValueChange, disabled }: ModelSelectorProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        Model Output
      </label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger aria-label="Select model output">
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.modelId} value={option.modelId}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
