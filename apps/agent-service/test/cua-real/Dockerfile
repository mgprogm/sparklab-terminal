# Local desktop image for the Virtual Computer REAL end-to-end run.
#
# The published trycua/xfce-cua:latest pins `cua-driver==0.12.4`, which predates
# the `mcp --direct` stdio entrypoint and the ActionResult contract that the
# spike (and every CUA doc under docs/) targets. Layer the checkout-matching
# 0.22.2 on top of the stock base (which already carries XFCE + Xvnc + noVNC +
# the venv at /opt/venv and the unprivileged `cua` user).
#
# Build:  docker build -t sparklab/cua-desktop:0.22.2 apps/agent-service/test/cua-real
# Use:    CUA_IMAGE=sparklab/cua-desktop:0.22.2 CUA_DRIVER_USER=cua CUA_ENABLED=true
FROM trycua/xfce-cua:latest

RUN /opt/venv/bin/python -m pip install --no-cache-dir --upgrade "cua-driver==0.22.2" \
 && chown cua:cua "$(/opt/venv/bin/python -c 'from cua_driver import get_binary_path; print(get_binary_path())')" \
 && su -s /bin/bash -c "HOME=/home/cua /opt/venv/bin/cua-driver --version" cua
