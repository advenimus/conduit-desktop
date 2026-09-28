import { useState } from "react";
import { Checkbox, FormField, PasswordInput, Radio, RadioGroup, SearchInput, Select, Slider, Switch, Textarea, TextInput } from "..";
import { SearchIcon } from "../../../lib/icons";
import { Demo, GallerySection } from "./Section";

function TextFields() {
  const [search, setSearch] = useState("web");
  const [password, setPassword] = useState("correct horse");
  return (
    <div className="grid max-w-[880px] grid-cols-2 gap-4">
      <FormField label="Vault name" description="Shown in the title bar">
        <TextInput placeholder="Enter new vault name" defaultValue="Work" />
      </FormField>
      <FormField label="Host" error="Enter a host name or an IP address">
        <TextInput placeholder="example.com" invalid defaultValue="exa mple" />
      </FormField>
      <FormField label="Master password">
        <PasswordInput placeholder="Enter master password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
      <FormField label="Search">
        <SearchInput placeholder="Search entries..." value={search} onChange={setSearch} />
      </FormField>
      <FormField label="With a leading icon">
        <TextInput placeholder="Filter" leading={<SearchIcon size={16} />} />
      </FormField>
      <FormField label="Disabled">
        <TextInput placeholder="Not editable" disabled />
      </FormField>
      <FormField label="Focused" description="The inset ring (spec 2.7)">
        <TextInput defaultValue="Focused field" data-gallery-focus="" />
      </FormField>
      <FormField label="Lock the vault when idle">
        <Select aria-label="Lock the vault when idle" defaultValue="15">
          <option value="5">After 5 minutes</option>
          <option value="15">After 15 minutes</option>
          <option value="0">Never</option>
        </Select>
      </FormField>
      <FormField label="Notes" className="col-span-2">
        <Textarea placeholder="Write something" defaultValue={"Line one\nLine two"} />
      </FormField>
    </div>
  );
}

function Toggles() {
  const [remember, setRemember] = useState(true);
  const [local, setLocal] = useState(true);
  const [style, setStyle] = useState("custom");
  const [scale, setScale] = useState(100);
  return (
    <>
      <Demo label="Checkbox: checked, unchecked, focus, disabled">
        <Checkbox checked={remember} onChange={setRemember}>
          Remember this device
        </Checkbox>
        <Checkbox checked={false} onChange={() => {}} description="With a second line">
          Unchecked
        </Checkbox>
        <Checkbox checked onChange={() => {}} data-gallery-focus="">
          Focused
        </Checkbox>
        <Checkbox checked onChange={() => {}} disabled>
          Disabled
        </Checkbox>
      </Demo>
      <Demo label="RadioGroup">
        <RadioGroup aria-label="Title bar" value={style} onChange={setStyle}>
          <Radio value="custom">Custom (recommended)</Radio>
          <Radio value="native">Native</Radio>
          <Radio value="focus" data-gallery-focus="">
            Focused option
          </Radio>
          <Radio value="off" disabled>
            Disabled option
          </Radio>
        </RadioGroup>
      </Demo>
      <Demo label="Switch: on, off, focus, disabled">
        <Switch checked={local} onChange={setLocal} label="Local Backup" />
        <Switch checked={!local} onChange={(v) => setLocal(!v)} label="Cloud Backup" />
        <Switch checked onChange={() => {}} label="Focused switch" data-gallery-focus="" />
        <Switch checked={false} onChange={() => {}} label="Disabled switch" disabled />
      </Demo>
      <Demo label="Slider">
        <div className="w-72">
          <Slider aria-label="UI scale" min={75} max={150} step={5} value={scale} onChange={(e) => setScale(Number(e.target.value))} marks={["75%", "100%", "150%"]} />
        </div>
      </Demo>
    </>
  );
}

export function FieldsSection() {
  return (
    <GallerySection id="fields" title="Text fields, Select, Checkbox, Radio, Switch, Slider">
      <TextFields />
      <Toggles />
    </GallerySection>
  );
}
