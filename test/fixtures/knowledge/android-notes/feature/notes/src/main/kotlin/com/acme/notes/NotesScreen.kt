package com.acme.notes

import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun NotesScreen(viewModel: NotesViewModel) {
    Button(onClick = { viewModel.save("Groceries", "Milk") }) {
        Text("Save")
    }
}
