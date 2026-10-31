# Google setup (Gmail, Drive, Sheets, Calendar)

The app works without Google. Set this up when you want Work Hub email, Drive filing, trackers that follow a Google Sheet, or Google Calendar.

Everything Google-related uses **one Google Cloud project** and an **OAuth client of type "Web application"**. Each person then allows access for their own Google account from inside the app; nobody shares a password.

## 1. Google Cloud project

In [Google Cloud console](https://console.cloud.google.com/):

1. **APIs & Services → Library**: enable the APIs for the features you use.

   | Feature | APIs |
   | --- | --- |
   | Work Hub email | Gmail API |
   | Saving attachments and documents to Drive | Google Drive API |
   | Trackers that follow a Google Sheet | Google Sheets API, Google Drive API |
   | Google Calendar | Google Calendar API |

2. **OAuth consent screen → Data access (Scopes)**: add the scopes for the features you use.

   | Feature | Scopes |
   | --- | --- |
   | Read Gmail in Work Hub | `gmail.readonly` |
   | Send email from the app | `gmail.send` |
   | Drive filing (only files the app creates) | `drive.file`, `userinfo.email` |
   | Read connected Sheets, and list Sheets to pick from | `spreadsheets.readonly`, `drive.metadata.readonly` |
   | Write to Sheets (done marks, two-way sync, Create Google Sheet, Gantt tab) | `spreadsheets` |
   | Calendar | `calendar.events.readonly`, `calendar.calendarlist.readonly` |

   Each scope is `https://www.googleapis.com/auth/<name>`. With an **Internal** consent screen (Google Workspace), no Google review is needed. With **External**, several of these are sensitive or restricted scopes, and an unverified app works only for the test users you list.

3. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized redirect URIs** add, with your app's public address in place of `APP_BASE_URL`:

   - `APP_BASE_URL/api/communications/gmail/callback` (Gmail, Drive and Sheets)
   - `APP_BASE_URL/api/integrations/google-calendar/callback` (Calendar)

   The app shows the exact address to copy on each settings screen. Download the client's JSON file.

If the app's public address changes, update these redirect URIs and upload the credentials again.

## 2. In the app

1. **Internal Admin** turns Gmail (and Calendar) on for the account.
2. An account **Administrator** opens **Settings → Integrations**:
   - **Gmail — account setup**: upload the OAuth JSON (or enter the Client ID and Client Secret).
   - **Google Drive**: connect the one shared Drive where the app files attachments and documents.
   - **Google Calendar**: upload the same OAuth JSON in the Calendar panel.
3. Each person:
   - connects their own Gmail in **Work Hub** and picks the labels to sync, and chooses **Allow sending email** once if they send email from the app;
   - allows Google Sheets once, from a tracker, the first time they connect a Sheet or edit a two-way one.

Credentials are stored encrypted with `TENANT_INTEGRATION_MASTER_KEY`. Keep that key: if it changes, saved credentials can no longer be read and must be entered again.
