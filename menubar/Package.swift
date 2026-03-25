// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PAAIRMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "PAAIRMenuBar",
            path: "Sources/PAAIRMenuBar"
        ),
    ]
)
