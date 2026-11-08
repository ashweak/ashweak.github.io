# BantayPondo data uploads

Monthly refresh (free, no terminal needed):

1. Open https://bettergov.ph/flood-control-projects and click **Export Data**.
2. Rename the downloaded file to `latest.csv`.
3. On GitHub, open this folder and choose **Add file → Upload files**, drop `latest.csv`, then **Commit changes**.

The "BantayPondo weekly update" workflow then rebuilds the flags and updates
https://ashweak.github.io/bantaypondo/ within a few minutes. Check
`bantaypondo/data/update-status.json` to see what the last run did.
