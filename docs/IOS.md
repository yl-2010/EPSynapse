# iOS app

Native EPSynapse for iPhone and iPad. Liquid Glass chrome, SF Symbols, student dashboard. The app calls `https://api.epsynapse.com`. On this Mac, debug builds can use `http://127.0.0.1:3006` instead.

## Generate and open

```bash
cd ios/EPSynapse
xcodegen generate
open EPSynapse.xcodeproj
```

XcodeGen writes `EPSynapse.xcodeproj`. Bundle ID is `com.jype.epsynapse`. Deployment target is iOS 18. Signing is Automatic with team `9KM694AP8A`.

One universal target (`TARGETED_DEVICE_FAMILY` 1,2). iPhone and iPad share the same app. iPad is not locked to full screen, so Split View works.

## API

`EPSApiBaseURL` in Info.plist is `https://api.epsynapse.com`. `EPSLocalApiBaseURL` is `http://127.0.0.1:3006`. ATS allows insecure HTTP for `localhost` and `127.0.0.1` only, so the simulator can hit the Mac API.

The dashboard covers Canvas, OneDrive, Outlook, and the personal agent. `canvas-courses` is listed in `LSApplicationQueriesSchemes` so the app can see if the Canvas client is installed.

No widgets, no location, no app groups.
