#!/bin/bash
# .deb post-remove script. electron-builder's default (app-builder-lib/templates/linux/after-remove.tpl, MIT,
# electron-builder 26.17.0) except for the `frameshell` command, which after-install.sh writes. electron-builder
# fills in ${executable} and ${sanitizedProductName}, so no other shell variable may use that brace form.

# Remove the command only while it still runs this package's CLI: an upgrade writes it again in after-install.sh.
if grep -qF '/opt/${sanitizedProductName}/resources/app.asar/' '/usr/bin/${executable}' 2>/dev/null; then
    rm -f '/usr/bin/${executable}'
fi
# The update-alternatives link of older packages, if one is left.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' >/dev/null 2>&1 || true
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi