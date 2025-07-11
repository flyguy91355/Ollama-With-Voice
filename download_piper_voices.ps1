$voices = @(
    # English (US)
    @{lang="en"; region="en_US"; name="amy"; quality="low"},
    @{lang="en"; region="en_US"; name="lessac"; quality="medium"},
    @{lang="en"; region="en_US"; name="ryan"; quality="high"},
    @{lang="en"; region="en_US"; name="kathleen"; quality="low"},
    @{lang="en"; region="en_US"; name="libritts"; quality="high"},
    # English (GB)
    @{lang="en"; region="en_GB"; name="alan"; quality="low"},
    @{lang="en"; region="en_GB"; name="arctic"; quality="medium"},
    # Spanish
    @{lang="es"; region="es_ES"; name="davefx"; quality="medium"},
    @{lang="es"; region="es_MX"; name="ald"; quality="medium"},
    # French
    @{lang="fr"; region="fr_FR"; name="siwis"; quality="low"},
    @{lang="fr"; region="fr_FR"; name="upmc"; quality="medium"},
    # German
    @{lang="de"; region="de_DE"; name="thorsten"; quality="low"},
    @{lang="de"; region="de_DE"; name="eva_k"; quality="x_low"},
    # Italian
    @{lang="it"; region="it_IT"; name="riccardo_fasol"; quality="x_low"},
    # Russian
    @{lang="ru"; region="ru_RU"; name="dmitri"; quality="medium"}
    # Add more voices as needed from https://huggingface.co/rhasspy/piper-voices
)

$voicesDir = "C:\piper-chat\piper\voices"
if (-not (Test-Path $voicesDir)) {
    New-Item -ItemType Directory -Path $voicesDir
}

foreach ($voice in $voices) {
    $fileName = "$($voice.region)-$($voice.name)-$($voice.quality)"
    $urlBase = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/$($voice.lang)/$($voice.region)/$($voice.name)/$($voice.quality)"
    $onnxUrl = "$urlBase/$fileName.onnx"
    $jsonUrl = "$urlBase/$fileName.onnx.json"
    $onnxPath = Join-Path $voicesDir "$fileName.onnx"
    $jsonPath = Join-Path $voicesDir "$fileName.onnx.json"

    Write-Host "Downloading $fileName..."
    Invoke-WebRequest -Uri $onnxUrl -OutFile $onnxPath
    Invoke-WebRequest -Uri $jsonUrl -OutFile $jsonPath
}