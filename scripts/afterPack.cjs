// scripts/afterPack.cjs
// electron-builder afterPack hook:
//   macOS  — compiles .icon to asset catalog for dark mode / tinted / liquid glass
//   Windows — stamps icon + version info via rcedit (signAndEditExecutable is off
//             because winCodeSign extraction fails on self-hosted runners)
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    await handleMacOS(context);
  } else if (context.electronPlatformName === 'win32') {
    await handleWindows(context);
  }
};

// ── macOS: compile .icon to asset catalog ─────────────────────────────
async function handleMacOS(context) {
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');

  const iconSource = path.resolve(__dirname, '../resources/icons/icon-macos.icon');

  if (!fs.existsSync(iconSource)) {
    console.warn('[afterPack] icon-macos.icon not found, skipping asset catalog compilation');
    return;
  }

  console.log('[afterPack] Compiling .icon to asset catalog...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-icon-'));

  try {
    // actool expects the .icon bundle with a specific name
    const destIcon = path.join(tmpDir, 'AppIcon.icon');
    fs.cpSync(iconSource, destIcon, { recursive: true });

    // Compile .icon to Assets.car + AppIcon.icns
    const actoolCmd = [
      'xcrun', 'actool',
      '--compile', resourcesPath,
      '--output-partial-info-plist', path.join(tmpDir, 'partial.plist'),
      '--platform', 'macosx',
      '--minimum-deployment-target', '11.0',
      '--app-icon', 'AppIcon',
      destIcon
    ].join(' ');

    execSync(actoolCmd, { encoding: 'utf-8', stdio: 'pipe' });

    // Verify Assets.car was created
    const carPath = path.join(resourcesPath, 'Assets.car');
    if (!fs.existsSync(carPath)) {
      console.warn('[afterPack] Assets.car was not created, falling back to .icns');
      return;
    }

    console.log('[afterPack] Assets.car created successfully');

    // Add CFBundleIconName to Info.plist so macOS uses the asset catalog icon
    // (CFBundleIconFile is already set by electron-builder for backward compat)
    execSync(
      `plutil -replace CFBundleIconName -string "AppIcon" "${infoPlistPath}"`,
      { encoding: 'utf-8' }
    );

    console.log('[afterPack] Added CFBundleIconName to Info.plist');
  } catch (err) {
    console.error('[afterPack] Error compiling .icon:', err.message);
    console.error('[afterPack] Falling back to .icns icon');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Windows: stamp icon + version info with rcedit ────────────────────
// electron-builder's signAndEditExecutable downloads winCodeSign which fails
// on self-hosted Windows runners (symlink privilege error). We keep it disabled
// and call rcedit ourselves here, before NSIS creates the installer.
async function handleWindows(context) {
  const appName = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${appName}.exe`);

  if (!fs.existsSync(exePath)) {
    console.error(`[afterPack] ${appName}.exe not found at ${exePath}`);
    return;
  }

  const iconPath = path.resolve(__dirname, '../build/icons/icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.error('[afterPack] icon.ico not found, skipping rcedit');
    return;
  }

  const appInfo = context.packager.appInfo;
  const version = appInfo.version;
  const productName = appInfo.productName;

  console.log(`[afterPack] Stamping icon and version into ${appName}.exe...`);

  try {
    const rcedit = require('rcedit');
    await rcedit(exePath, {
      icon: iconPath,
      'version-string': {
        ProductName: productName,
        FileDescription: productName,
        CompanyName: appInfo.companyName || '',
        LegalCopyright: appInfo.copyright || '',
      },
      'file-version': version,
      'product-version': version,
    });
    console.log('[afterPack] Icon and version info stamped successfully');
  } catch (err) {
    console.error('[afterPack] rcedit failed:', err.message);
    throw err; // Fail the build so we notice
  }
}
