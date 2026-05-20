# Homebrew formula — FrogTalk desktop (Linux + macOS via electron-builder cask-style)
# Submit: brew bump-formula-pr or open PR at https://github.com/Homebrew/homebrew-cask
#
# For linuxbrew/core style (prebuilt deb on Linux):
class Frogtalk < Formula
  desc "Federated end-to-end encrypted chat with voice and video"
  homepage "https://frogtalk.xyz"
  version "1.5.3"
  license "MIT"

  on_macos do
    url "https://github.com/deadinternetfox/frogtalk/releases/download/v#{version}/FrogTalk-#{version}-mac.zip"
    sha256 "REPLACE_AFTER_RELEASE"
  end

  on_linux do
    url "https://github.com/deadinternetfox/frogtalk/releases/download/v#{version}/frogtalk_#{version}_amd64.deb"
    sha256 "REPLACE_AFTER_RELEASE"
  end

  depends_on "electron" => :recommended

  def install
    if OS.mac?
      prefix.install Dir["*"]
      bin.write_exec_script prefix/"FrogTalk.app/Contents/MacOS/FrogTalk"
    else
      system "dpkg-deb", "-x", cached_download, buildpath/"extract"
      lib.install Dir["extract/opt/FrogTalk/*"]
      (bin/"frogtalk").write <<~EOS
        #!/bin/bash
        exec electron#{Formula["electron"].version.major} "#{lib}/app" "$@"
      EOS
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/frogtalk --version", 2).strip
  rescue
    system "#{bin}/frogtalk", "--help"
  end
end
