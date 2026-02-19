# Glossaire

## ASR

Automatic Speech Recognition. Conversion audio -> texte.

## WebGPU

Backend de calcul GPU navigateur, generalement le plus performant.

## WASM

WebAssembly. Backend CPU compatible multi-plateforme.

## COOP / COEP

Headers navigateur necessaires pour isolation cross-origin et multithread WASM.

## Chunking

Decoupage audio en segments de traitement.

## Dedupe

Suppression des chevauchements textuels entre chunks.

## VAD

Voice Activity Detection. Detection des zones voix/silence.

## LUFS

Unite de loudness percue pour normalisation audio.

## Progressive mode

Traitement segment par segment pour limiter pression memoire.

## TelemetryCollector

Collecteur d evenements/temps/alerts pour diagnostic runtime.

## CRI / CRO / CRS

Formats de compte rendu generes par module LLM.

## Context window

Nombre maximal de tokens lisibles par le modele LLM.

## Dtype

Precision numerique d execution modele (q4, q8, fp16, etc.).

## Gradio

Provider/endpoint d inference expose via API web.

## Hugging Face Inference

Service d inference cloud utilise pour Whisper et LLM cloud HF.

## Mistral API

API cloud utilisee pour transcription audio et generation LLM.

## Diarization

Detection et etiquetage des intervenants audio (speakers) par segment.

## Speaker assignment

Mapping manuel d un speaker technique vers un nom/prenom affiche et exporte.

## Export run snapshot header

Bloc metadata en tete des exports (`VTT`/`SRT`/`JSON`/`telemetry`) qui decrit les settings/runtime reels du run.
