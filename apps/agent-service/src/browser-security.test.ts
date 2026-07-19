import assert from "node:assert/strict";
import test from "node:test";
import { isPublicIp, validateBrowserUrl } from "./browser-security.js";

test("rejects private, reserved, and metadata addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "64:ff9b:1::1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001:2::1",
    "2001:10::1",
    "2001:db8::1",
    "2002:0a00:0001::1",
    "3fff::1",
    "5f00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  assert.equal(isPublicIp("2001:4860:4860::8888"), true);
});

test("requires credential-free absolute HTTP(S) URLs", async () => {
  await assert.rejects(validateBrowserUrl("/relative"));
  await assert.rejects(validateBrowserUrl("file:///etc/passwd"));
  await assert.rejects(validateBrowserUrl("data:text/plain,hello"));
  await assert.rejects(validateBrowserUrl("javascript:alert(1)"));
  await assert.rejects(validateBrowserUrl("https://user:secret@example.com/"));
  await assert.rejects(validateBrowserUrl("http://localhost/"));
  // WHATWG URL parsing canonicalizes these legacy IPv4 spellings. They must
  // not bypass the loopback policy.
  await assert.rejects(validateBrowserUrl("http://2130706433/"));
  await assert.rejects(validateBrowserUrl("http://0x7f000001/"));
  await assert.rejects(
    validateBrowserUrl("http://169.254.169.254/latest/meta-data"),
  );
});
