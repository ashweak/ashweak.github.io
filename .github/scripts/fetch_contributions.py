"""Save the GitHub contribution calendar of one user as JSON for the portfolio.

Usage: python3 fetch_contributions.py <github-login> <output.json>

Reads the public calendar page first (the same numbers the GitHub profile shows).
If that fails, it falls back to the GraphQL API using GITHUB_TOKEN.
It never overwrites the output with data that does not look like a full year.
"""
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.request

LEVELS = {"NONE": 0, "FIRST_QUARTILE": 1, "SECOND_QUARTILE": 2, "THIRD_QUARTILE": 3, "FOURTH_QUARTILE": 4}


def get(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "ashweak-portfolio-contributions", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def attrs(tag):
    return {k: html.unescape(v) for k, v in re.findall(r'([\w-]+)="([^"]*)"', tag)}


def parse_page(page):
    """Parse github.com/users/<login>/contributions."""
    tips = {}
    for for_id, text in re.findall(r'<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>(.*?)</tool-tip>', page, re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
        if text.lower().startswith("no contribution"):
            tips[for_id] = 0
        else:
            m = re.match(r"([\d,]+)\s+contribution", text)
            if m:
                tips[for_id] = int(m.group(1).replace(",", ""))
    days = []
    for tag in re.findall(r"<(?:td|rect)\b[^>]*\bdata-date=\"[^\"]+\"[^>]*>", page):
        a = attrs(tag)
        if "data-level" not in a:
            continue
        count = tips.get(a.get("id", ""))
        if count is None and a.get("data-count", "").isdigit():
            count = int(a["data-count"])
        if count is None:
            raise ValueError("no count for " + a["data-date"])
        days.append({"date": a["data-date"], "count": count, "level": int(a["data-level"])})
    total = None
    m = re.search(r'id="js-contribution-activity-description"[^>]*>\s*([\d,]+)\s+contribution', page)
    if m:
        total = int(m.group(1).replace(",", ""))
    return days, total


def from_page(login):
    return parse_page(get(f"https://github.com/users/{login}/contributions"))


def from_graphql(login):
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("no GITHUB_TOKEN")
    q = ("query($l:String!){user(login:$l){contributionsCollection{contributionCalendar{totalContributions "
         "weeks{contributionDays{date contributionCount contributionLevel}}}}}}")
    body = json.dumps({"query": q, "variables": {"l": login}}).encode()
    res = json.loads(get("https://api.github.com/graphql", body, {"Authorization": "bearer " + token, "Content-Type": "application/json"}))
    cal = res["data"]["user"]["contributionsCollection"]["contributionCalendar"]
    days = [{"date": d["date"], "count": d["contributionCount"], "level": LEVELS[d["contributionLevel"]]}
            for w in cal["weeks"] for d in w["contributionDays"]]
    return days, cal["totalContributions"]


def check(days):
    days = sorted({d["date"]: d for d in days}.values(), key=lambda d: d["date"])
    if len(days) < 360:
        raise ValueError(f"only {len(days)} days")
    prev = None
    for d in days:
        cur = dt.date.fromisoformat(d["date"])
        if prev and (cur - prev).days != 1:
            raise ValueError(f"gap between {prev} and {cur}")
        if not 0 <= d["level"] <= 4 or d["count"] < 0:
            raise ValueError("bad value on " + d["date"])
        if (d["count"] == 0) != (d["level"] == 0):
            raise ValueError("count and level disagree on " + d["date"])
        prev = cur
    return days


def main():
    login, out = sys.argv[1], sys.argv[2]
    errors = []
    for name, fn in (("profile page", from_page), ("GraphQL API", from_graphql)):
        try:
            days, total = fn(login)
            days = check(days)
            source = name
            break
        except Exception as e:  # try the next source
            errors.append(f"{name}: {e}")
    else:
        sys.exit("Could not read contributions. " + " | ".join(errors))
    data = {
        "login": login,
        "source": source,
        "total": total if total is not None else sum(d["count"] for d in days),
        "from": days[0]["date"],
        "to": days[-1]["date"],
        "days": days,
    }
    old = None
    if os.path.exists(out):
        try:
            old = json.load(open(out))
        except ValueError:
            pass
    if old and {k: v for k, v in old.items() if k != "updated"} == data:
        print("No change.")
        return
    data["updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"Saved {len(days)} days, {data['total']} contributions, from the {source}.")


if __name__ == "__main__":
    main()
