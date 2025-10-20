# auto-commit.ps1 - Versão Final Corrigida
Write-Host "Auto-Commit para server.js (30s)..." -ForegroundColor Green

while ($true) {
    Start-Sleep -Seconds 30
    
    try {
        $status = git status --porcelain
        if ($status -match "server.js") {
            Write-Host "Mudancas detectadas no server.js..." -ForegroundColor Yellow
            
            git add server.js
            git commit -m "Auto-save: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            git push origin main
            
            Write-Host "Salvo no GitHub! $(Get-Date)" -ForegroundColor Green
            Write-Host "Localizacao: monday-script/server.js" -ForegroundColor Cyan
            Write-Host "Proxima verificacao em 30 segundos..." -ForegroundColor Gray
            Write-Host ""
        } else {
            Write-Host "Sem mudancas - $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray
        }
    }
    catch {
        Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Continuando monitoramento..." -ForegroundColor Yellow
    }
}