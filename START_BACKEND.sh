#!/bin/bash

# LeQture Backend Server Startup Script

echo "=========================================="
echo "LeQture Backend Server"
echo "=========================================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is not installed"
    echo "Please install Python 3 first"
    exit 1
fi

echo "✓ Python 3 found: $(python3 --version)"

# Check if Tesseract is installed
if ! command -v tesseract &> /dev/null; then
    echo "❌ Error: Tesseract OCR is not installed"
    echo "Install with: brew install tesseract (macOS)"
    exit 1
fi

echo "✓ Tesseract found: $(tesseract --version | head -n 1)"

# Check if requirements are installed
echo ""
echo "Checking Python dependencies..."
if ! python3 -c "import flask" &> /dev/null; then
    echo "⚠️  Flask not found. Installing dependencies..."
    pip3 install -r requirements.txt
else
    echo "✓ Dependencies installed"
fi

echo ""
echo "=========================================="
echo "Starting Backend Server..."
echo "=========================================="
echo ""
echo "Server will run on: http://localhost:5000"
echo "Press Ctrl+C to stop"
echo ""

# Start the server
python3 server.py
