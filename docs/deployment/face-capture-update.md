# Face capture comfort update

Registration asks for a small left/right turn, with a shorter pause. Browser guidance
uses a 17-degree target instead of 20; the server's default 15-degree requirement and
all server identity, duplicate-face, quality and liveness checks are unchanged.

Straight-face registration waits for four good readings instead of ten. Punch capture
waits for three instead of six. A missed face detection under 400 ms pauses progress;
poor lighting, multiple faces or a longer dropout still reset it. Only a valid current
frame can complete the hold.

The eye step first asks for open eyes to calibrate, then a brief close and reopen. It
can capture one closed-eye reading instead of needing two, which helps slower tablets.
Its icon follows the open/close prompt. After four seconds (previously ten), the existing
**Take the photo now** fallback is available. It still requires one well-positioned,
adequately lit face and server verification. The fourth review thumbnail is labelled
**Eye photo** because the existing fallback does not require closed eyes.

These changes do not guarantee performance in darkness or on every camera. Test the
actual tablet in its working light. People should never strain their neck to register.

## Updating the AWS deployment

Once Vercel has successfully deployed the new branch commit, refresh the tablet page.
For the shared message changes on AWS, run:

```sh
cd /opt/ajpwer
git pull --ff-only origin feature/clean-hrms-experience
sudo systemctl restart ajpwer-api
```

No database migration, employee reset, model download or Python face-service restart is
needed. If Vercel does not automatically deploy this branch, deploy its latest commit
from the Vercel project dashboard before testing.
