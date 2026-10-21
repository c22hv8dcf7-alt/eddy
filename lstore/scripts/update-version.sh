#!/bin/bash

# Check if a version number was provided
if [ -z "$1" ]; then
    echo "❌ Please provide a version number (e.g., ./update-version.sh 0.3.7)"
    exit 1
fi

NEW_VERSION=$1

echo "🔄 Updating local app files to version $NEW_VERSION..."

# 1. Update the version inside lstore/data/apps.json
if [ -f "lstore/data/apps.json" ]; then
    sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/g" lstore/data/apps.json
    echo "✅ Updated lstore/data/apps.json"
fi

# 2. Update the version inside lstore/desktop/Info.plist
if [ -f "lstore/desktop/Info.plist" ]; then
    sed -i '' "s/<string>[0-9]*\.[0-9]*\.[0-9]*<\/string>/<string>$NEW_VERSION<\/string>/g" lstore/desktop/Info.plist
    echo "✅ Updated lstore/desktop/Info.plist"
fi

echo "🎉 All local app store version updates completed successfully!"

