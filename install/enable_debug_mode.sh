#!/bin/bash
# Enables unsigned CEP extensions in Adobe Premiere Pro (macOS).
# Run this once, then restart Premiere Pro.
# CEP versions 9–11 cover Premiere CC 2019 through 2024.

defaults write com.adobe.CSXS.9  PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1

echo "Debug mode enabled. Restart Premiere Pro for the change to take effect."
