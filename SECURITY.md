# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/hamzahamidi/publish-to-firefox-add-ons/security/advisories/new). Do not open a public issue for it.

Expect an acknowledgement within 7 days. A fix ships as a patch release of the latest major version, the major tag moves to it, and the advisory is published once the release is out.

The action sends credentials to `addons.mozilla.org` only, and refuses redirects to anywhere else. The API secret itself never leaves the process: each request carries a JWT signed with it that lives at most 5 minutes. The action masks the API key, the API secret and every JWT it signs, returns none as an output and stores no credential. Before any request, it scans the package and the source ZIP for the key and the secret and refuses to upload either when it finds them. The README lists every request it makes.
