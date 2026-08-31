$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is required. Install it, then run 'gh auth login'."
}

$repo = "lussifa/dify-for-vscode"
gh repo create $repo --public --source . --remote origin --push --description "A native VS Code coding agent powered directly by a Dify Chatflow, with YOLO mode."
Write-Host "Created and pushed: https://github.com/$repo"
