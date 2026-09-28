import { CloudOff, Crown, FileX, FingerprintPattern, Heading1, Heading2, QrCode, Zap } from "lucide-react";
import { codiconGlyphs } from "../generated/codicons";
import { createGlyphIcons } from "../glyph";
import type { IconMapping } from "../types";
import { wrapLucide } from "./lucide-wrap";

// The eight names without a fitting Codicon borrow Lucide glyphs (spec A.1).
export const mapping: IconMapping = {
  ...createGlyphIcons(codiconGlyphs, "Codicon"),
  fingerprint: wrapLucide(FingerprintPattern),
  fileX: wrapLucide(FileX),
  crown: wrapLucide(Crown),
  cloudOff: wrapLucide(CloudOff),
  bolt: wrapLucide(Zap),
  qrcode: wrapLucide(QrCode),
  heading1: wrapLucide(Heading1),
  heading2: wrapLucide(Heading2),
};
